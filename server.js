'use strict';

const express = require('express');
const line = require('@line/bot-sdk');

const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'DEEPSEEK_API_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const MAX_HISTORY_MESSAGES = 20;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是一位聰明、友善且條理分明的 AI 助理，請一律使用繁體中文（台灣習慣用語）回答問題。';
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });
const app = express();
let botUserIdPromise;
const generatedImages = new Map();
const NVIDIA_IMAGE_ENDPOINT = 'https://ai.api.nvidia.com/v1/genai/qwen/qwen-image';

// Render free instances may restart or sleep; in-memory history is intentionally temporary.
// Use a persistent database if conversation history must survive restarts or scale to replicas.
const histories = new Map();

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('LINE DeepSeek bot is running.'));
app.get('/generated/:id', (req, res) => {
  const image = generatedImages.get(req.params.id);
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=300').type(image.mimeType).send(image.bytes);
});
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  // Acknowledge LINE promptly; process events asynchronously so webhook retries are less likely.
  res.status(200).json({ status: 'ok' });
  Promise.all((req.body.events || []).map(handleEvent)).catch((err) => {
    console.error('Webhook event processing failed:', err);
  });
});

async function handleEvent(event) {
  if (event.type !== 'message' || !['text', 'image'].includes(event.message.type) || !event.replyToken) return;
  const source = event.source || {};
  // In group and multi-person room chats, only respond when LINE marks this bot as mentioned.
  const isGroupChat = Boolean(source.groupId || source.roomId);
  if (isGroupChat && !(await isMentionedBot(event.message))) return;
  // Group members share one context; one-to-one chats keep an individual context.
  const chatId = source.groupId || source.roomId || source.userId;
  if (!chatId) return;
  const rawMessage = event.message.type === 'text' ? event.message.text : '';
  const message = (isGroupChat ? removeBotMention(rawMessage, event.message) : rawMessage).trim()
    || (event.message.type === 'image' ? '請描述這張圖片。' : '');
  if (!message) return;

  if (message === '/說明' || message.toLowerCase() === '/help') {
    return reply(event.replyToken, '🤖 DeepSeek 機器人指令\n\n/設定 [角色描述]：自訂角色\n/目前設定：查看角色與記憶輪數\n/清除記憶：清除對話脈絡\n/恢復預設：恢復預設角色並清除記憶');
  }
  if (message === '/清除記憶' || message.toLowerCase() === '/reset') {
    histories.delete(chatId);
    return reply(event.replyToken, '🧹 已清除對話記憶，可以開始新的話題了。');
  }
  if (message === '/恢復預設') {
    histories.delete(chatId);
    return reply(event.replyToken, '🔄 已清除對話記憶。固定人設由管理員在 Render 的 SYSTEM_PROMPT 環境變數設定。');
  }
  if (message === '/目前設定' || message.toLowerCase() === '/status') {
    const history = histories.get(chatId) || [];
    return reply(event.replyToken, `⚙️ 目前設定\n模型：${MODEL}\n已記憶訊息：${history.length} / ${MAX_HISTORY_MESSAGES} 則\n固定人設：\n${SYSTEM_PROMPT}`);
  }
  if (message === '/設定' || message.startsWith('/設定 ') || message.toLowerCase() === '/prompt' || message.toLowerCase().startsWith('/prompt ')) {
    return reply(event.replyToken, '此機器人使用固定人設。管理員可在 Render → Environment 設定 SYSTEM_PROMPT，儲存後重新部署即可套用。');
  }

  const imagePrompt = message.match(/^\/(?:生圖|畫圖)\s+(.+)$/s);
  if (imagePrompt) {
    if (!process.env.NVIDIA_API_KEY) return reply(event.replyToken, '⚠️ 管理員尚未在 Render 設定 NVIDIA_API_KEY。');
    await reply(event.replyToken, '🎨 收到描述，正在生成圖片…');
    try {
      const image = await generateImage(imagePrompt[1].trim());
      const imageId = crypto.randomUUID();
      generatedImages.set(imageId, image);
      setTimeout(() => generatedImages.delete(imageId), 10 * 60 * 1000).unref();
      const publicBaseUrl = (process.env.PUBLIC_BASE_URL || inferPublicBaseUrl()).replace(/\/$/, '');
      if (!publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not configured');
      await pushImage(chatId, `${publicBaseUrl}/generated/${imageId}`);
    } catch (err) {
      console.error('NVIDIA image generation failed:', err);
      const detail = safeErrorMessage(err);
      await pushText(chatId, `⚠️ 圖片生成失敗：\n${detail}`);
    }
    return;
  }

  try {
    const history = histories.get(chatId) || [];
    const displayName = source.userId ? await getLineDisplayName(source) : null;
    const attributedMessage = displayName
      ? `【發言者：${displayName}】\n${message}`
      : message;
    const imageDataUrl = event.message.type === 'image' ? await getLineImageDataUrl(event.message.id) : null;
    const answer = await askDeepSeek(chatId, attributedMessage, history, imageDataUrl);
    // Reply token is single-use and expires quickly; API failure replies are handled too.
    await reply(event.replyToken, answer);
  } catch (err) {
    console.error('Message handling failed:', err);
    await reply(event.replyToken, '⚠️ 目前無法取得 AI 回覆，請稍後再試。');
  }
}

function removeBotMention(text, message) {
  const ranges = (message.mention?.mentionees || [])
    .filter((mentionee) => mentionee.isSelf === true)
    .map(({ index, length }) => ({ index, length }))
    .filter(({ index, length }) => Number.isInteger(index) && Number.isInteger(length) && length > 0)
    .sort((a, b) => b.index - a.index);
  let result = text;
  for (const { index, length } of ranges) {
    result = result.slice(0, index) + result.slice(index + length);
  }
  return result;
}

function safeErrorMessage(err) {
  const raw = String(err?.message || '未知錯誤')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隱藏]')
    .replace(/(NVIDIA_API_KEY\s*[=:]\s*)\S+/gi, '$1[已隱藏]');
  return [...raw].slice(0, 1200).join('');
}

function inferPublicBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return null;
}

async function generateImage(prompt) {
  if (!prompt || prompt.length > 2000) throw new Error('Prompt must be between 1 and 2000 characters.');
  const response = await fetch(NVIDIA_IMAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, height: 1024, width: 1024, samples: 1, seed: 0, steps: 30 }),
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error(`NVIDIA API HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const result = await response.json();
  const encoded = result.image || result.b64_image || result.base64 || result.artifacts?.[0]?.base64
    || result.images?.[0]?.b64_json || result.images?.[0] || result.data?.[0]?.b64_json
    || result.data?.[0]?.image || result.data?.[0]?.url;
  if (!encoded || typeof encoded !== 'string') {
    const summary = JSON.stringify({ keys: Object.keys(result || {}), dataKeys: Object.keys(result?.data?.[0] || {}), message: result?.detail || result?.message || result?.error }).slice(0, 700);
    throw new Error(`NVIDIA response did not contain a recognized image field. Response: ${summary}`);
  }
  if (/^https?:\/\//i.test(encoded)) {
    const imageResponse = await fetch(encoded, { signal: AbortSignal.timeout(30000) });
    if (!imageResponse.ok) throw new Error(`Could not download NVIDIA image URL: HTTP ${imageResponse.status}`);
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    return { bytes: Buffer.from(await imageResponse.arrayBuffer()), mimeType: contentType };
  }
  const match = encoded.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  const mimeType = match ? match[1] : 'image/jpeg';
  const bytes = Buffer.from(match ? match[2] : encoded, 'base64');
  if (!bytes.length) throw new Error('NVIDIA returned an empty image.');
  return { bytes, mimeType };
}

async function getLineImageDataUrl(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${lineConfig.channelAccessToken}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`LINE image download failed: HTTP ${response.status}`);
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mimeType)) throw new Error(`Unsupported image type: ${mimeType}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Image is larger than DeepSeek inline image limit (32 MiB).');
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function isMentionedBot(message) {
  const mentionees = message.mention?.mentionees || [];
  if (mentionees.some((mentionee) => mentionee.isSelf === true)) return true;
  if (!mentionees.some((mentionee) => mentionee.type === 'user' && mentionee.userId)) return false;
  try {
    const botUserId = process.env.LINE_BOT_USER_ID || await getBotUserId();
    return mentionees.some((mentionee) => mentionee.type === 'user' && mentionee.userId === botUserId);
  } catch (err) {
    console.error('Could not identify bot mention. Check LINE channel access token and webhook payload:', err.message);
    return false;
  }
}

async function getLineDisplayName(source) {
  try {
    let profile;
    if (source.type === 'group' && source.groupId) {
      profile = await lineClient.getGroupMemberProfile(source.groupId, source.userId);
    } else if (source.type === 'room' && source.roomId) {
      profile = await lineClient.getRoomMemberProfile(source.roomId, source.userId);
    } else {
      profile = await lineClient.getProfile(source.userId);
    }
    return profile.displayName || null;
  } catch (err) {
    // Profile access may be unavailable for some events or accounts; chat should still work.
    console.warn('Could not retrieve LINE display name:', err.message);
    return null;
  }
}

async function getBotUserId() {
  if (!botUserIdPromise) {
    botUserIdPromise = lineClient.getBotInfo().then((profile) => profile.userId).catch((err) => {
      botUserIdPromise = undefined;
      throw err;
    });
  }
  return botUserIdPromise;
}

async function askDeepSeek(chatId, userMessage, history, imageDataUrl = null) {
  const userContent = imageDataUrl
    ? [
        { type: 'text', text: userMessage },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : userMessage;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: imageDataUrl ? 'deepseek-flash' : MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    console.error(`DeepSeek API returned ${response.status}: ${detail}`);
    throw new Error(`DeepSeek API returned ${response.status}`);
  }
  const result = await response.json();
  const answer = result.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('DeepSeek returned no answer');

  // Store a text-only summary for image turns to keep memory bounded and avoid replaying image payloads.
  const storedUserMessage = imageDataUrl ? `${userMessage}（已附圖片）` : userMessage;
  const updated = [...history, { role: 'user', content: storedUserMessage }, { role: 'assistant', content: answer }];
  histories.set(chatId, updated.slice(-MAX_HISTORY_MESSAGES));
  return answer;
}

async function reply(replyToken, text) {
  const safeText = [...String(text)].slice(0, 4900).join('');
  try {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: safeText || '（沒有文字內容）' }],
    });
  } catch (err) {
    console.error('LINE reply failed:', err);
  }
}

async function pushImage(chatId, imageUrl) {
  try {
    await lineClient.pushMessage({
      to: chatId,
      messages: [{ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl }],
    });
  } catch (err) {
    console.error('LINE image push failed:', err);
  }
}

async function pushText(chatId, text) {
  try {
    await lineClient.pushMessage({ to: chatId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('LINE error push failed:', err);
  }
}

app.listen(PORT, () => console.log(`LINE DeepSeek bot listening on port ${PORT}`));
