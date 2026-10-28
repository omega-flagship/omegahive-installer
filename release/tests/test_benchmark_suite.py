import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
BENCHMARK = ROOT / "docs" / "review" / "benchmark_suite.py"


def load_benchmark():
    spec = importlib.util.spec_from_file_location("benchmark_suite", BENCHMARK)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class BenchmarkSuiteTests(unittest.TestCase):
    def test_context_fixture_budget_is_deterministic_and_comparable(self):
        bench = load_benchmark()
        result = bench.context_fixture_benchmark(bench.Target("candidate", ROOT))

        self.assertEqual([row["name"] for row in result["rows"]], ["idle", "fresh-message", "tool-heavy-feedback"])
        self.assertGreater(result["avg_token_estimate"], 1000)
        self.assertEqual(result["rows"][0]["components"]["history_chars"], result["max_history"])
        self.assertIn("skills_chars", result["rows"][0]["components"])


if __name__ == "__main__":
    unittest.main()
