// ============================================
// PayPal backend для KondWorld
// Принимает запросы от сайта, общается с PayPal,
// после успешной оплаты вызывает ваш Minecraft-сервер
// для выдачи привилегии.
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());        // разрешаем запросы с вашего сайта
app.use(express.json());

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE,
  PAYPAL_CURRENCY,
  PORT,
  MINECRAFT_BACKEND_URL
} = process.env;

const PAYPAL_API_BASE =
  PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// ---------- Цены привилегий (должны совпадать с сайтом) ----------
// Если на сайте админ меняет цены через localStorage, эти значения
// нужно тоже обновлять здесь, иначе сервер будет проверять заказ
// по своей (старой) цене. Самый надёжный вариант — присылать сюда
// rankId с сайта, а цену брать ИЗ ЭТОГО списка, а не верить тому,
// что присылает браузер пользователя (иначе любой может подделать
// сумму через консоль браузера и купить дорогой ранг за 1 рубль).
const RANK_PRICES = {
  vip: 99,
  baron: 199,
  strazh: 349,
  hero: 499,
  squid: 699,
  glava: 999,
  elita: 1499,
  titan: 1999,
  prince: 2999,
  knyaz: 3999,
  duke: 5999
};

// ---------- Получение access token у PayPal ----------
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Не удалось получить токен PayPal: ' + errText);
  }

  const data = await response.json();
  return data.access_token;
}

// ---------- 1. Создание заказа PayPal ----------
// Сайт вызывает этот эндпоинт, когда игрок нажал "Оплатить" с методом PayPal.
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { rankId, nickname } = req.body;

    if (!rankId || !RANK_PRICES[rankId]) {
      return res.status(400).json({ error: 'Неизвестный rankId' });
    }
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ error: 'Не указан никнейм' });
    }

    const price = RANK_PRICES[rankId];
    const accessToken = await getPayPalAccessToken();

    const orderResponse = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            description: `Привилегия ${rankId} для ${nickname} (KondWorld)`,
            amount: {
              currency_code: PAYPAL_CURRENCY || 'USD',
              value: price.toFixed(2)
            },
            custom_id: JSON.stringify({ rankId, nickname })
          }
        ]
      })
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      console.error('Ошибка создания заказа PayPal:', orderData);
      return res.status(500).json({ error: 'Ошибка создания заказа PayPal' });
    }

    res.json({ orderId: orderData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------- 2. Подтверждение (списание) оплаты ----------
// Сайт вызывает этот эндпоинт ПОСЛЕ того, как игрок подтвердил
// платёж в окне PayPal. Именно тут реально списываются деньги.
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'Не указан orderId' });
    }

    const accessToken = await getPayPalAccessToken();

    const captureResponse = await fetch(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    const captureData = await captureResponse.json();

    if (!captureResponse.ok || captureData.status !== 'COMPLETED') {
      console.error('Платёж не завершён:', captureData);
      return res.status(400).json({ error: 'Платёж не подтверждён', details: captureData });
    }

    // Извлекаем rankId и nickname, которые мы сохранили при создании заказа
    const purchaseUnit = captureData.purchase_units[0];
    const customId = purchaseUnit.custom_id ? JSON.parse(purchaseUnit.custom_id) : {};
    const { rankId, nickname } = customId;
    const amountPaid = purchaseUnit.payments.captures[0].amount.value;

    // Выдаём привилегию через ваш Minecraft-бэкенд
    const serverCommand = `lp user ${nickname} parent set ${rankId}`;
    let deliveryOk = true;
    try {
      await fetch(`${MINECRAFT_BACKEND_URL}/api/delivery-reward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, command: serverCommand, rankId })
      });
    } catch (deliveryErr) {
      console.error('Не удалось выдать привилегию на сервере:', deliveryErr);
      deliveryOk = false;
    }

    res.json({
      success: true,
      rankId,
      nickname,
      amountPaid,
      deliveryOk
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/', (req, res) => {
  res.send('KondWorld PayPal backend работает.');
});

const port = PORT || 4000;
app.listen(port, () => {
  console.log(`PayPal backend запущен на порту ${port} (режим: ${PAYPAL_MODE})`);
});
