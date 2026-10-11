import unittest

from select_simulator import choose_device
from write_iteration_summary import make_record


class ReviewReceiptTests(unittest.TestCase):
    def env(self, api="success", ios="success"):
        return dict(API_RESULT=api, IOS_RESULT=ios, GITHUB_SERVER_URL="https://github.com",
                    GITHUB_REPOSITORY="example/inventory", GITHUB_RUN_ID="123",
                    GITHUB_RUN_ATTEMPT="2", GITHUB_REF="refs/pull/7/merge", GITHUB_EVENT_NAME="pull_request")

    def test_pr_source_is_separate_from_tested_merge(self):
        event = {"number": 7, "pull_request": {"head": {"sha": "source-sha"}, "html_url": "https://github.com/example/inventory/pull/7"}}
        record = make_record(event, self.env(), "merge-sha")
        self.assertEqual(record["source_commit"], "source-sha")
        self.assertEqual(record["tested_commit"], "merge-sha")
        self.assertEqual(record["ux_acceptance"], "not_assessed_by_ci")

    def test_unsuccessful_job_cannot_produce_pass_receipt(self):
        for status in ("failure", "cancelled", "skipped"):
            with self.subTest(status=status):
                self.assertFalse(make_record({}, self.env(ios=status), "sha")["automated_checks_passed"])
        with self.assertRaises(ValueError):
            make_record({}, self.env(ios="unknown"), "sha")

    def test_push_without_pr(self):
        env = self.env()
        env.update(GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/design/example")
        record = make_record({}, env, "sha")
        self.assertIsNone(record["pull_request"])
        self.assertEqual(record["source_commit"], "sha")

    def test_simulator_requires_available_supported_iphone(self):
        usable = "A1234567-1234-1234-1234-123456789012"
        device = {"name": "iPhone 16", "udid": usable, "isAvailable": True}
        self.assertEqual(choose_device({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-18-5": [device]}}), usable)
        for runtime, item in [("com.apple.CoreSimulator.SimRuntime.iOS-16-4", device),
                              ("com.apple.CoreSimulator.SimRuntime.iOS-18-5", {**device, "isAvailable": False}),
                              ("com.apple.CoreSimulator.SimRuntime.iOS-18-5", {**device, "name": "iPad Pro"})]:
            with self.subTest(runtime=runtime, item=item), self.assertRaises(ValueError):
                choose_device({"devices": {runtime: [item]}})


if __name__ == "__main__":
    unittest.main()
