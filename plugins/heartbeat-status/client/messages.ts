import { defineTranslations } from "@getpaseo/plugin/client";

export const messages = defineTranslations({
  resources: {
    en: {
      heading: "Scheduled heartbeat",
      direct: "Scheduled heartbeat",
      children: "Child heartbeat",
      both: "Agent and child heartbeats",
      agent: "Agent {{id}}",
      details: "{{name}} · Scheduled heartbeats on this agent: {{direct}}. On descendants: {{descendants}}.",
      help: "An enabled heartbeat sends a prompt when its schedule is due.",
    },
    "zh-CN": {
      heading: "定时心跳",
      direct: "定时心跳",
      children: "子会话心跳",
      both: "本会话和子会话心跳",
      agent: "会话 {{id}}",
      details: "{{name}} · 本会话的定时心跳：{{direct}}，后代会话的定时心跳：{{descendants}}。",
      help: "已启用的心跳会在到期时发送提示。",
    },
  },
});
