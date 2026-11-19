import json
import os
import re
import unittest

from _load import ROOT, PLUGIN, FIX

# the eleven skills of upstream's v2 pack, under skills/
SKILLS = ["trader-scanner", "trader-news", "trader-entry", "trader-exit", "trader-timemachine",
          "trader-risk", "trader-budget", "trader-broker", "trader-alerts", "trader-analyst",
          "trader-pelosi"]
UPSTREAM = "3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd"
# skills on the way to an order carry the safety block
ORDER_PATH = ["trader-scanner", "trader-entry", "trader-exit", "trader-timemachine", "trader-budget",
              "trader-pelosi", "trader-risk", "trader-broker", "trader-alerts"]
V1_ONLY = ["trader-copycat", "trader-screener", "trader-tax", "trader-rebalance"]


def frontmatter(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return (m.group(1) if m else ""), text


def every_text_file():
    for base, dirs, files in os.walk(PLUGIN):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__")]
        for f in files:
            if f.endswith((".md", ".py", ".json", ".csv", ".txt", ".xml")) or f == "LICENSE":
                yield os.path.join(base, f)


class Repo(unittest.TestCase):
    def test_eleven_skill_folders(self):
        found = sorted(d for d in os.listdir(ROOT)
                       if os.path.isfile(os.path.join(ROOT, d, "SKILL.md")))
        self.assertEqual(found, sorted(SKILLS))
        self.assertEqual(sorted(os.listdir(ROOT)), sorted(SKILLS))

    def test_plugin_layout(self):
        root = sorted(d for d in os.listdir(PLUGIN) if d not in ("__pycache__",))
        self.assertEqual(root, sorted([".claude-plugin", "LICENSE", "README.md", "skills", "tests"]))
        # no MCP server of its own: the merrymen plugin carries the one connection
        self.assertFalse(os.path.exists(os.path.join(PLUGIN, ".mcp.json")))

    def test_frontmatter_name_and_description(self):
        for s in SKILLS:
            fm, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            self.assertIn("name: %s\n" % s, fm + "\n", s)
            self.assertRegex(fm, r"description: ", s)
            self.assertGreater(len(fm), 200, "%s description is too thin" % s)
            self.assertGreater(len(text.splitlines()), 60, s)

    def test_order_path_skills_carry_the_safety_rule(self):
        with open(os.path.join(ROOT, "trader-broker", "SKILL.md"), encoding="utf-8") as fh:
            broker = fh.read()
        block = broker[broker.index("## Safety"):]
        self.assertIn("approved the proposal in Merrymen", " ".join(block.split()))
        for s in ORDER_PATH:
            _, text = frontmatter(os.path.join(ROOT, s, "SKILL.md"))
            low = " ".join(text.lower().split())
            self.assertIn("not financial advice", low, s)
            self.assertIn("yes", low, s)
            self.assertIn("merrymen", low, s)
            if s != "trader-pelosi":
                self.assertEqual(text[text.index("## Safety"):], block, s)

    def test_plugin_manifest(self):
        with open(os.path.join(PLUGIN, ".claude-plugin", "plugin.json")) as fh:
            plugin = json.load(fh)
        self.assertEqual(plugin["name"], "merrymen-trader")
        self.assertRegex(plugin["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(plugin["license"], "MIT")
        self.assertNotIn("skills", plugin)              # skills/ is where Claude Code looks by default
        self.assertNotIn("mcpServers", plugin)

    def test_readme_installs_and_credits(self):
        with open(os.path.join(PLUGIN, "README.md"), encoding="utf-8") as fh:
            readme = " ".join(fh.read().split())
        self.assertTrue(readme.startswith("# Merrymen Day Trader"))
        for line in ("/plugin marketplace add https://github.com/millw14/merrymen.git",
                     "/plugin install merrymen@merrymen", "/plugin install merrymen-trader@merrymen",
                     "https://github.com/Jakeschincariol/day-trader-skill", UPSTREAM,
                     "Suggest trades for you to approve", "## Fine print", "Not financial advice"):
            self.assertIn(line, readme)
        for s in SKILLS:
            self.assertIn("/merrymen-trader:" + s, readme, s)

    def test_license_is_upstreams(self):
        with open(os.path.join(PLUGIN, "LICENSE"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue(text.startswith("MIT License"))
        self.assertIn("Copyright (c) 2026 Jake Schincariol", text)

    def test_no_em_dashes_and_no_personal_email(self):
        for path in every_text_file():
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            rel = os.path.relpath(path, PLUGIN)
            if not rel.startswith(os.path.join("tests", "fixtures")):  # fixtures are real data, kept as published
                self.assertNotIn("\u2014", text, rel)
            self.assertNotIn("jakeschincariol" + "@" + "gmail.com", text, rel)  # built, so this file passes too

    def test_no_v1_only_skill_is_left_behind(self):
        for path in every_text_file():
            rel = os.path.relpath(path, PLUGIN)
            if rel.startswith("tests" + os.sep) or rel == "README.md":
                continue
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            for old in V1_ONLY:
                self.assertNotIn(old, text, rel)

    def test_every_tool_runs_on_python_3_8(self):
        # no 3.9+ only modules or syntax in the tools (the README promises 3.8)
        for s in SKILLS:
            folder = os.path.join(ROOT, s)
            for f in os.listdir(folder):
                if not f.endswith(".py"):
                    continue
                with open(os.path.join(folder, f), encoding="utf-8") as fh:
                    src = fh.read()
                for bad in ("import zoneinfo", "from zoneinfo", ".removeprefix(", ".removesuffix(",
                            "match ", "list[", "dict[", "tuple["):
                    if bad == "match ":
                        self.assertNotRegex(src, r"(?m)^\s+match \w+.*:$", "%s/%s" % (s, f))
                    elif bad.endswith("["):
                        self.assertNotRegex(src, r"(?<![\w.])%s" % re.escape(bad), "%s/%s" % (s, f))
                    else:
                        self.assertNotIn(bad, src, "%s/%s" % (s, f))

    def test_day_trading_limits_ship_in_the_example_config(self):
        with open(os.path.join(ROOT, "trader-budget", "config.example.json")) as fh:
            cfg = json.load(fh)
        for k in ("max_loss_per_trade_usd", "max_daily_loss_usd", "max_trades_per_day",
                  "min_reward_risk", "require_stop", "no_entries_after", "flat_by", "merrymen_agent",
                  "reserve_exit_budget", "max_quote_gap_pct"):
            self.assertIn(k, cfg, k)
        self.assertIs(cfg["require_stop"], True)
        self.assertIs(cfg.get("allow_short", False), False)
        self.assertIs(cfg.get("allow_margin", False), False)

    def test_paper_trading_is_the_default(self):
        with open(os.path.join(ROOT, "trader-budget", "config.example.json")) as fh:
            cfg = json.load(fh)
        self.assertIs(cfg["paper"], True)
        self.assertEqual(cfg["broker"], "merrymen")
        self.assertIs(cfg.get("allow_options", False), False)

    def test_upstream_alpaca_config_is_a_test_fixture_only(self):
        self.assertTrue(os.path.exists(os.path.join(FIX, "trader-budget", "config.alpaca.json")))
        self.assertFalse(os.path.exists(os.path.join(ROOT, "trader-broker", "claude_desktop_config.example.json")))


if __name__ == "__main__":
    unittest.main()
