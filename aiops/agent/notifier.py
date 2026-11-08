"""Gửi thông báo sự cố kèm nút Duyệt/Từ chối qua Telegram và/hoặc Slack.

TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → sendMessage với inline keyboard (nút URL tới /actions/{id}/approve|reject?token=…)
SLACK_WEBHOOK_URL → Incoming Webhook với block "actions" chứa 2 nút URL.
Không cấu hình (hoặc NOTIFY_ENABLED=false) → chỉ ghi log. Test dùng httpx.MockTransport, không gửi thật.
"""

from __future__ import annotations

import html
import logging
import os

import httpx

log = logging.getLogger("aiops.notifier")


class Notifier:
    def __init__(self, telegram_token: str | None = None, telegram_chat: str | None = None,
                 slack_webhook: str | None = None, enabled: bool = True, transport: httpx.BaseTransport | None = None,
                 telegram_api: str = "https://api.telegram.org"):
        self.tg_token, self.tg_chat, self.slack = telegram_token, telegram_chat, slack_webhook
        self.enabled = enabled
        self.tg_api = telegram_api
        self.client = httpx.Client(timeout=10, transport=transport)
        self.sent: list[dict] = []

    @classmethod
    def from_env(cls, transport=None) -> "Notifier":
        return cls(os.getenv("TELEGRAM_BOT_TOKEN") or None, os.getenv("TELEGRAM_CHAT_ID") or None,
                   os.getenv("SLACK_WEBHOOK_URL") or None,
                   os.getenv("NOTIFY_ENABLED", "true").lower() in ("1", "true", "yes"), transport)

    @property
    def channels(self) -> list[str]:
        out = []
        if self.enabled and self.tg_token and self.tg_chat:
            out.append("telegram")
        if self.enabled and self.slack:
            out.append("slack")
        return out or ["log"]

    def notify(self, title: str, body: str, approve_url: str | None = None, reject_url: str | None = None,
               incident_url: str | None = None) -> list[dict]:
        results = []
        for ch in self.channels:
            try:
                if ch == "telegram":
                    results.append(self._telegram(title, body, approve_url, reject_url, incident_url))
                elif ch == "slack":
                    results.append(self._slack(title, body, approve_url, reject_url, incident_url))
                else:
                    log.info("THÔNG BÁO %s\n%s\nduyệt=%s từ chối=%s", title, body, approve_url, reject_url)
                    results.append({"channel": "log", "ok": True})
            except httpx.HTTPError as e:
                log.error("gửi %s lỗi: %s", ch, e)
                results.append({"channel": ch, "ok": False, "error": str(e)})
        self.sent.extend(results)
        return results

    def _telegram(self, title, body, approve, reject, link):
        text = f"<b>{html.escape(title)}</b>\n{html.escape(body)[:3500]}"
        payload: dict = {"chat_id": self.tg_chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        row = []
        if approve:
            row.append({"text": "✅ Duyệt", "url": approve})
        if reject:
            row.append({"text": "❌ Từ chối", "url": reject})
        buttons = [row] if row else []
        if link:
            buttons.append([{"text": "🔎 Chi tiết", "url": link}])
        if buttons:
            payload["reply_markup"] = {"inline_keyboard": buttons}
        r = self.client.post(f"{self.tg_api}/bot{self.tg_token}/sendMessage", json=payload)
        return {"channel": "telegram", "ok": r.status_code == 200, "status": r.status_code}

    def _slack(self, title, body, approve, reject, link):
        blocks: list[dict] = [{"type": "header", "text": {"type": "plain_text", "text": title[:150]}},
                              {"type": "section", "text": {"type": "mrkdwn", "text": body[:2900]}}]
        elems = []
        if approve:
            elems.append({"type": "button", "style": "primary", "text": {"type": "plain_text", "text": "Duyệt"}, "url": approve})
        if reject:
            elems.append({"type": "button", "style": "danger", "text": {"type": "plain_text", "text": "Từ chối"}, "url": reject})
        if link:
            elems.append({"type": "button", "text": {"type": "plain_text", "text": "Chi tiết"}, "url": link})
        if elems:
            blocks.append({"type": "actions", "elements": elems})
        r = self.client.post(self.slack, json={"text": title, "blocks": blocks})
        return {"channel": "slack", "ok": r.status_code == 200, "status": r.status_code}
