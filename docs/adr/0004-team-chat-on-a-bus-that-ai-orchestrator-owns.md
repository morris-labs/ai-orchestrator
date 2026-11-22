# Team chat on a bus that AI Orchestrator owns

Status: accepted

Agents exchange messages through a message bus that AI Orchestrator owns and
reach it through an MCP server, not through Claude Code's teammate
messaging. The Critic and the Test engineer run on Codex by default, and
Claude Code's messaging reaches only Claude agents.

Every message is a file, and the team chat is a view of those files. The
engine delivers each message straight to its addressee, so a message costs
tokens only in the context that receives it. A relay through the Project
manager would also spend a turn on the largest context in the build. When a
message arrives for an agent whose turn ended, the engine resumes that
agent's session. The owner can read every message and can post to any agent.

## Considered options

- **The Project manager relays every message.** This option was rejected
  because each relay costs a turn on the Project manager's context as well
  as the addressee's, and the relays fill that context.
- **Chat messages apart from the handoff files.** This option was rejected
  because agents would spend tokens to restate what a file already says.
- **Channels, side chats, and slices from the start.** This option was put
  off to phase 2. Direct addressing covers the known cases, and the message
  files will show whether threads with several members are needed.
