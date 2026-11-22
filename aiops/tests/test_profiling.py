"""Continuous profiling cho RCA: giải mã flamegraph (nhóm 4 số), hàm tăng tỉ trọng so với hôm qua, công cụ MCP
cpu_profile, planner thêm giả thuyết có trích bằng chứng khi triệu chứng là CPU."""

import json

import httpx

from aiops.collectors.pyroscope import PyroscopeClient, self_by_function

# main(self 10) → handler(self 20) → regexMatch(self 70); tổng 100. values: [offset Δ, total, self, chỉ số tên]
HOT = {"names": ["total", "main", "handler", "regexMatch"], "total": "100", "maxSelf": "70",
       "levels": [{"values": ["0", "100", "0", "0"]}, {"values": ["0", "100", "10", "1"]},
                  {"values": ["0", "90", "20", "2"]}, {"values": ["0", "70", "70", "3"]}]}
# hôm qua: regexMatch chỉ 3%, phần lớn ở handler
BASE = {"names": ["total", "main", "handler", "regexMatch"], "total": 100,
        "levels": [{"values": [0, 100, 0, 0]}, {"values": [0, 100, 40, 1]}, {"values": [0, 60, 57, 2]}, {"values": [0, 3, 3, 3]}]}


def _client(calls=None, now=1_800_000_000.0):
    def handler(req: httpx.Request):
        body = json.loads(req.content)
        if calls is not None:
            calls.append(body)
        assert req.url.path == "/querier.v1.QuerierService/SelectMergeStacktraces"
        fg = HOT if body["end"] >= int((now - 3600) * 1000) else BASE
        return httpx.Response(200, json={"flamegraph": fg})
    return PyroscopeClient("http://pyro:4040", transport=httpx.MockTransport(handler))


def test_decode_self_by_function():
    acc, total = self_by_function(HOT)
    assert acc == {"total": 0, "main": 10, "handler": 20, "regexMatch": 70} and total == 100


def test_hot_functions_finds_regression_vs_yesterday():
    calls, now = [], 1_800_000_000.0
    r = _client(calls, now).hot_functions("catalog", now - 900, now)
    assert calls[0]["labelSelector"] == '{service_name="catalog"}' and calls[0]["start"] == int((now - 900) * 1000)
    assert calls[1]["end"] == int((now - 86400) * 1000)                         # cùng khung giờ hôm qua
    assert r["top_self"][0] == {"function": "regexMatch", "share": 0.7, "baseline_share": 0.03}
    assert r["regressions"][0]["function"] == "regexMatch" and r["regressions"][0]["delta"] == 0.67
    assert all(x["function"] != "handler" for x in r["regressions"])          # handler giảm tỉ trọng → không phải hồi quy


def test_planner_adds_profile_hypothesis(tmp_path):
    from .test_agent_api import alert
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        resp = c.app.state.responder
        resp.profiler = _client(now=resp.clock())
        inc = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert("search", name="HighCPUThrottling")]}).json()
        inv = c.post(f"/incidents/{inc['incidents'][0]}/agent-investigate").json()
        tools = [s["tool"] for s in inv["steps"]]
        assert "cpu_profile" in tools, tools
        prof_ev = next(s["evidence"] for s in inv["steps"] if s["tool"] == "cpu_profile")
        hyp = next(h for h in inv["hypotheses"] if "regexMatch" in h["cause"])
        assert prof_ev in hyp["evidence"] and "3% → 70%" in hyp["cause"]
        # không có Pyroscope → công cụ trả ghi chú, không lỗi
        resp.profiler = None
        from aiops.mcp.tools import Toolbox
        ev = Toolbox(resp).call("cpu_profile", {"service": "search"})
        assert ev.ok and "không có Pyroscope" in ev.data["note"]
