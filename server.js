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
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_HISTORY_MESSAGES = 20;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是一位聰明、友善且條理分明的 AI 助理，請一律使用繁體中文（台灣習慣用語）回答問題。';
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });
const app = express();
let botUserIdPromise;

// Render free instances may restart or sleep; in-memory history is intentionally temporary.
// Use a persistent database if conversation history must survive restarts or scale to replicas.
const histories = new Map();

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('LINE DeepSeek bot is running.'));
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  // Acknowledge LINE promptly; process events asynchronously so webhook retries are less likely.
  res.status(200).json({ status: 'ok' });
  Promise.all((req.body.events || []).map(handleEvent)).catch((err) => {
    console.error('Webhook event processing failed:', err);
  });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text' || !event.replyToken) return;
  const source = event.source || {};
  // In group and multi-person room chats, only respond when LINE marks this bot as mentioned.
  const isGroupChat = Boolean(source.groupId || source.roomId);
  if (isGroupChat && !(await isMentionedBot(event.message))) return;
  // Group members share one context; one-to-one chats keep an individual context.
  const chatId = source.groupId || source.roomId || source.userId;
  if (!chatId) return;
  const message = event.message.text.trim();
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

  try {
    const history = histories.get(chatId) || [];
    const displayName = source.userId ? await getLineDisplayName(source) : null;
    const attributedMessage = displayName
      ? `【發言者：${displayName}】\n${message}`
      : message;
    const answer = await askDeepSeek(chatId, attributedMessage, history);
    // Reply token is single-use and expires quickly; API failure replies are handled too.
    await reply(event.replyToken, answer);
  } catch (err) {
    console.error('Message handling failed:', err);
    await reply(event.replyToken, '⚠️ 目前無法取得 AI 回覆，請稍後再試。');
  }
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

async function askDeepSeek(chatId, userMessage, history) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userMessage },
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

  const updated = [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: answer }];
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

app.listen(PORT, () => console.log(`LINE DeepSeek bot listening on port ${PORT}`));
