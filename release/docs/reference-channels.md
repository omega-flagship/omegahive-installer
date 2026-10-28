> **Current.** The ChannelEvent contract that `modules/channel_router/src/router.py` implements. See `LEGACY.md` for which other docs are legacy.

# Reference — Channels

Channels are the I/O surface the agent uses to talk to the outside world. Adapters live in `channels/`; MeTTa-side dispatch lives in `src/channels.metta`.

## The adapter contract

Each adapter exposes:

| Function | Purpose |
|---|---|
| `start_<name>(...)` | Called once from `initChannels`. Opens sockets / spawns listener threads as needed. |
| `getLastMessage()` | Returns the next unread inbound message as a string. Returns `""` if none. |
| `getLastEvents()` | Optional but preferred. Returns structured `ChannelEvent` payloads for the latest inbound messages. |
| `send_message(str)` | Posts an outbound message. |

## ChannelEvent Contract

Channel modules should keep raw transport traces exact, but the agent-facing
context should use typed `CHANNEL_EVENT` views. A channel event separates
transport metadata from dialogue text:

| Field | Purpose |
|---|---|
| `event` | Message transition such as `message`, `message-notice`, `reaction`, `edit`, `delete`, or `notice`. |
| `channel` | Transport membrane, for example `whatsapp`, `telegram`, `mattermost`, `web_control`, or `glucose`. |
| `route` | Routing mode such as `primary-operator`, `control`, `explicit-chat`, or `inspect`. |
| `conversation_id` | Transport routing handle. Show it only when explicit routing is needed. |
| `message_id` | Quote/react/edit handle. Default context may expose only whether it is available. |
| `sender` | Human, app, or agent source label. |
| `text` | Utterance or app notice content only. Do not prepend route labels, JIDs, chat ids, or message ids. |
| `reply_affordance` | Safe next command shape, such as `send message` or `send-whatsapp-to conversation_id message`. |

Primary/control conversations should make the correct action natural:

```text
CHANNEL_EVENT
event=message
channel=whatsapp
route=primary-operator
message_id=available
sender=Primary Operator
text=hello
reply_affordance=send message
```

Explicit non-current chats may expose the route handle as metadata because the
route is not implicit:

```text
CHANNEL_EVENT
event=message-notice
channel=whatsapp
route=explicit-chat
conversation_id=secondary@lid
message_id=available
sender=Secondary Contact
text=<inspect-chat-for-current-text>
reply_affordance=send-whatsapp-to conversation_id message
```

Older adapters may still return flat notice strings for compatibility. The
router can parse those as a fallback, but new channel work should emit
structured `ChannelEvent` payloads directly rather than relying on string
recovery.

The MeTTa side reads `commchannel` and branches:

```metta
(= (receive)
   (if (== (commchannel) irc)
       (py-call (irc.getLastMessage))
       (if (== (commchannel) telegram)
           (py-call (telegram.getLastMessage))
           (if (== (commchannel) slack)
               (py-call (slack.getLastMessage))
               (py-call (mattermost.getLastMessage))))))
```

## `channels/irc.py`

IRC adapter with simple one-time-secret authentication.

- `start_irc(channel, server, port, user)` — connect and join.
- Inbound traffic is filtered to the first user who types `auth <one-time-secret>`. All other speakers are ignored.
- Uses QuakeNet (`irc.quakenet.org`) by default.

## `channels/mattermost.py`

Mattermost adapter using a bot token.

- `start_mattermost(url, channel_id, bot_token)` — connect to a Mattermost instance.
- Requires `MM_BOT_TOKEN` configured (empty by default — set via `configure` or command line).

## `channels/telegram.py`

Telegram adapter using Bot API long polling.

- `start_telegram(bot_token, chat_id, poll_timeout, auth_secret)` — starts a poll loop.
- `TG_CHAT_ID` is optional; if empty, the adapter can auto-bind to the first valid inbound chat.
- When `auth_secret` is set, pending updates are preserved until a private chat, group, or channel sends `/auth <secret>`.
- Startup and poll decisions are logged with `[TELEGRAM]` diagnostics; message bodies are not printed in diagnostics.
- Outbound messages are chunked to Telegram-safe lengths.

## `channels/slack.py`

Slack adapter using Slack Web API polling.

- `start_slack(bot_token, channel_id, poll_interval)` — starts a poll loop.
- Requires `SL_BOT_TOKEN`; `SL_CHANNEL_ID` is optional.
- The bot user must already be invited to the target channel.
- If `SL_CHANNEL_ID` is empty, the adapter auto-binds to the first channel where auth succeeds.
- Adapter respects Slack `Retry-After` backoff on HTTP 429 and enforces a minimum 60s poll interval.
- Uses the same one-time `auth <secret>` ownership gate as the other adapters.

## `channels/websearch.py`

Not a communication channel in the `send`/`receive` sense — this is the backend for the `web-search` skill. Exposes `websearch.search(query)` to the MeTTa wrapper.

## Adding a new channel

See [tutorial-04-adding-a-channel.md](./tutorial-04-adding-a-channel.md).

## Related reference

- [reference-skills-communication.md](./reference-skills-communication.md) — the MeTTa surface (`send`, `receive`, `web-search`).
- [reference-configuration.md](./reference-configuration.md) — channel parameters.
