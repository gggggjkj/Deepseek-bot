# LINE DeepSeek Bot on Render

Node.js LINE webhook bot with DeepSeek chat, shared group conversation context with sender attribution, and the `/目前設定`, `/清除記憶`, `/恢復預設`, and `/help` commands. The system persona is fixed through the `SYSTEM_PROMPT` environment variable.

## Deploy to Render

1. Push this project to a GitHub repository.
2. In Render, create a **Web Service** from the repository. Render can use `render.yaml` automatically.
3. Add these environment variables in the Render service settings:
   - `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API channel access token.
   - `LINE_CHANNEL_SECRET`: LINE Messaging API channel secret.
   - `LINE_BOT_USER_ID`: the bot's LINE user ID, used to detect an actual @mention in groups. Find it from a webhook event's `message.mention.mentionees[].userId` when the bot is mentioned, or via LINE's bot info API.
   - `DEEPSEEK_API_KEY`: API key from DeepSeek.
   - `SYSTEM_PROMPT`: fixed persona applied after every restart/deploy. Set this in Render to change the bot's role.
   - Optional: `DEEPSEEK_MODEL` (defaults to `deepseek-chat`).
4. After deployment, set the LINE Developers **Webhook URL** to `https://YOUR-RENDER-DOMAIN/webhook`, enable **Use webhook**, then use **Verify**.
5. Add the bot as a LINE friend and send `/help` to confirm it responds.

Do not commit `.env` or paste API keys into source code. `.env.example` lists the variable names for local use.

## Notes

- LINE webhook signature verification is enabled by `@line/bot-sdk` middleware.
- Group and room members share the same conversation history (up to the latest 20 messages); one-to-one chats have separate history. Each incoming message includes the sender's LINE display name in DeepSeek context when LINE provides it.
- In groups and rooms, the bot responds only when LINE marks the bot itself in the message mention metadata. Direct chats continue to work normally. Configure `LINE_BOT_USER_ID` in Render.
- Group and room profile lookup depends on LINE making that member profile available; failures do not prevent replies.
- `/設定` now explains that the persona is fixed. Change it in Render → Environment by editing `SYSTEM_PROMPT`, then save and redeploy; `/恢復預設` clears chat history without changing the persona.
- The included history and custom prompts live in memory. Render restarts, free-instance sleeps, or multiple instances can clear or separate that state. Add a persistent database such as Redis or PostgreSQL if history must persist.
- LINE reply tokens expire quickly. For very slow model responses, use a LINE push message flow instead of a reply token.
