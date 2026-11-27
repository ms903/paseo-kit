Brings back agents whose tab you closed by mistake, with one press.

Closing an agent's tab, for example with Ctrl+W or Cmd+W, archives the agent and stops its process; Paseo only asks first when the agent is running. This plugin adds a **Closed agents** panel that lists the archived top-level agents of the current workspace, most recently closed first. Open it from the Command Center (Ctrl+K or Cmd+K, then "Reopen a closed agent") or place it in the Explorer sidebar.

Press an agent to reopen it. The plugin unarchives the agent, resumes its session with the full history, and opens its tab again once the app shows the agent as running. This is the same request as the Unarchive button in an archived agent's tab. Subagents are not listed, because closing a subagent's tab only hides it.

On Paseo 0.18.1, the plugin reads the agent from the connected daemon and calls the SDK's `reload()` method after confirming that it is an archived top-level agent in this workspace. Older hosts that lack this method use `paseo agent reload <id>` and need a matching CLI on the daemon's PATH. The panel lists the latest 50 agents per workspace by default. Choose 10, 25 or 50 under **Settings → Plugins → Closed agents → History**. The panel refreshes its archived-agent cache every 30 seconds. Private background agents stay hidden.

Without the plugin you can restore an agent from **History** in the sidebar: open the archived agent, then press Unarchive in its tab. To stop closing tabs by accident, rebind or unassign "Close current tab" in Paseo's keyboard shortcut settings.
