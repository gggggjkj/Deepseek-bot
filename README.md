# LINE DeepSeek Bot on Render

Node.js LINE webhook bot with DeepSeek chat, per-person conversation context, and the `/設定`, `/目前設定`, `/清除記憶`, `/恢復預設`, and `/help` commands.

## Deploy to Render

1. Push this project to a GitHub repository.
2. In Render, create a **Web Service** from the repository. Render can use `render.yaml` automatically.
3. Add these environment variables in the Render service settings:
   - `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API channel access token.
   - `LINE_CHANNEL_SECRET`: LINE Messaging API channel secret.
   - `DEEPSEEK_API_KEY`: API key from DeepSeek.
   - Optional: `DEEPSEEK_MODEL` (defaults to `deepseek-chat`).
4. After deployment, set the LINE Developers **Webhook URL** to `https://YOUR-RENDER-DOMAIN/webhook`, enable **Use webhook**, then use **Verify**.
5. Add the bot as a LINE friend and send `/help` to confirm it responds.

Do not commit `.env` or paste API keys into source code. `.env.example` lists the variable names for local use.

## Notes

- LINE webhook signature verification is enabled by `@line/bot-sdk` middleware.
- Group and room members share the same conversation history (up to the latest 20 messages); one-to-one chats have separate history. Each incoming message includes the sender's LINE display name in DeepSeek context when LINE provides it.
- Group and room profile lookup depends on LINE making that member profile available; failures do not prevent replies.
- The included history and custom prompts live in memory. Render restarts, free-instance sleeps, or multiple instances can clear or separate that state. Add a persistent database such as Redis or PostgreSQL if history must persist.
- LINE reply tokens expire quickly. For very slow model responses, use a LINE push message flow instead of a reply token.
