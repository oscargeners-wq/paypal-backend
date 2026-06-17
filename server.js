// ============================================================================
// KondWorld — PayPal backend
// Express-сервер, который создаёт и подтверждает заказы PayPal (Orders API v2).
//
// ГЛАВНОЕ: на сайте все цены указаны в гривнах (грн), а PayPal принимает
// только реальные валюты (USD, EUR и т.д.). Поэтому сервер сам переводит
// цену из грн в USD перед тем, как создать заказ в PayPal — PayPal никогда
// не должен получать "грн" как "USD" напрямую.
// ============================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------------------------------------------------------
// Конфигурация из .env
// ----------------------------------------------------------------------------
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox', // 'sandbox' или 'live'
  PORT = 4000,
  MINECRAFT_BACKEND_URL,
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('❌ Не заданы PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET в .env');
  process.exit(1);
}

const PAYPAL_API_BASE =
  PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// ----------------------------------------------------------------------------
// Курс конвертации гривна -> доллар.
// Меняйте только это число, если курс поменяется — больше ничего трогать не нужно.
// ----------------------------------------------------------------------------
const UAH_TO_USD = 41.5;

// ----------------------------------------------------------------------------
// Цены привилегий в ГРИВНАХ (должны совпадать с defaultPrice на сайте).
// Если меняете цену на сайте — поменяйте и здесь, иначе сервер будет считать
// заказ по старой цене.
// ----------------------------------------------------------------------------
const RANK_PRICES_UAH = {
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
  duke: 5999,
};

// Человеко-читаемые названия — используются в описании заказа PayPal.
const RANK_NAMES = {
  vip: 'VIP',
  baron: 'Барон',
  strazh: 'Страж',
  hero: 'Герой',
  squid: 'Сквид',
  glava: 'Глава',
  elita: 'Элита',
  titan: 'Титан',
  prince: 'Принц',
  knyaz: 'Князь',
  duke: 'Герцог',
};

// ----------------------------------------------------------------------------
// Фиксированные цены в USD для первых двух привилегий.
// Эти два ранга НЕ конвертируются по курсу — цена всегда ровно такая, как ниже.
// ----------------------------------------------------------------------------
const FIXED_USD_PRICES = {
  vip: 0.10,
  baron: 0.50,
};

/**
 * Возвращает цену в USD (число с 2 знаками после запятой) для указанного rankId.
 * - vip и baron -> фиксированная цена из FIXED_USD_PRICES
 * - всё остальное -> конвертация из гривен по курсу UAH_TO_USD
 */
function getPriceUSD(rankId) {
  if (Object.prototype.hasOwnProperty.call(FIXED_USD_PRICES, rankId)) {
    return FIXED_USD_PRICES[rankId];
  }

  const priceUAH = RANK_PRICES_UAH[rankId];
  if (priceUAH === undefined) {
    return null; // неизвестный rankId
  }

  return Number((priceUAH / UAH_TO_USD).toFixed(2));
}

// ----------------------------------------------------------------------------
// Получение access token от PayPal (OAuth2 client_credentials)
// ----------------------------------------------------------------------------
async function getPaypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Не удалось получить PayPal access token: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ----------------------------------------------------------------------------
// POST /api/paypal/create-order
// Принимает { rankId, nickname }, создаёт заказ в PayPal на правильную сумму
// в USD и возвращает { orderId }.
// ----------------------------------------------------------------------------
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { rankId, nickname } = req.body;

    if (!rankId || !nickname) {
      return res.status(400).json({ error: 'Не указан rankId или nickname' });
    }

    const priceUAH = RANK_PRICES_UAH[rankId];
    const priceUSD = getPriceUSD(rankId);

    if (priceUSD === null) {
      return res.status(400).json({ error: `Неизвестная привилегия: ${rankId}` });
    }

    const rankName = RANK_NAMES[rankId] || rankId;
    const accessToken = await getPaypalAccessToken();

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // Сохраняем привязку к привилегии и игроку, чтобы при capture
          // знать, что именно выдавать на сервере.
          custom_id: JSON.stringify({ rankId, nickname }),
          description: `KondWorld — привилегия ${rankName} (${nickname})`,
          amount: {
            currency_code: 'USD',
            value: priceUSD.toFixed(2), // <-- ВСЕГДА доллары, никогда гривны напрямую
          },
        },
      ],
    };

    const orderResponse = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(orderPayload),
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      console.error('Ошибка создания заказа PayPal:', orderData);
      return res.status(500).json({ error: 'Не удалось создать заказ PayPal' });
    }

    console.log(
      `🆕 Заказ создан: rank=${rankId} nickname=${nickname} priceUAH=${priceUAH ?? 'fixed'} priceUSD=${priceUSD} orderId=${orderData.id}`
    );

    return res.json({ orderId: orderData.id, priceUSD });
  } catch (err) {
    console.error('Ошибка /api/paypal/create-order:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/paypal/capture-order
// Принимает { orderId }, подтверждает (capture) платёж в PayPal,
// при успехе — выдаёт привилегию на Minecraft-сервер через MINECRAFT_BACKEND_URL.
// ----------------------------------------------------------------------------
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Не указан orderId' });
    }

    const accessToken = await getPaypalAccessToken();

    const captureResponse = await fetch(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const captureData = await captureResponse.json();

    if (!captureResponse.ok || captureData.status !== 'COMPLETED') {
      console.error('Ошибка подтверждения заказа PayPal:', captureData);
      return res.status(400).json({ success: false, error: 'Платёж не подтверждён' });
    }

    const purchaseUnit = captureData.purchase_units && captureData.purchase_units[0];
    const capture = purchaseUnit && purchaseUnit.payments && purchaseUnit.payments.captures
      ? purchaseUnit.payments.captures[0]
      : null;

    const amountPaid = capture ? capture.amount.value : null;

    let rankId = null;
    let nickname = null;
    try {
      const customData = JSON.parse(purchaseUnit.custom_id);
      rankId = customData.rankId;
      nickname = customData.nickname;
    } catch (e) {
      console.warn('Не удалось разобрать custom_id из заказа PayPal:', purchaseUnit && purchaseUnit.custom_id);
    }

    console.log(
      `✅ Заказ подтверждён: orderId=${orderId} rank=${rankId} nickname=${nickname} amountPaid=${amountPaid} USD`
    );

    // Выдаём привилегию на Minecraft-сервер, если известен бэкенд и rankId/nickname.
    if (MINECRAFT_BACKEND_URL && rankId && nickname) {
      try {
        const serverCommand = `lp user ${nickname} parent set ${rankId}`;
        await fetch(`${MINECRAFT_BACKEND_URL}/api/delivery-reward`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, command: serverCommand, rankId }),
        });
      } catch (deliveryErr) {
        // Платёж уже прошёл успешно — не валим запрос, просто логируем,
        // чтобы привилегию можно было выдать вручную при сбое связи с Minecraft-сервером.
        console.error('Ошибка выдачи привилегии на Minecraft-сервер:', deliveryErr);
      }
    }

    return res.json({
      success: true,
      amountPaid,
      rankId,
      nickname,
    });
  } catch (err) {
    console.error('Ошибка /api/paypal/capture-order:', err);
    return res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// ----------------------------------------------------------------------------
// Проверка работоспособности сервера
// ----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'ok', mode: PAYPAL_MODE });
});

app.listen(PORT, () => {
  console.log(`🚀 PayPal backend запущен на порту ${PORT} (режим: ${PAYPAL_MODE})`);
});
