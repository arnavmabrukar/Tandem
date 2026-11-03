"""Exercise untrusted plan content without contacting a model or database."""
import unittest
from uuid import uuid4

from pydantic import ValidationError

from mediator.schemas.plans import PlanProposal, RevisePlanRequest


def task(key, dependencies=None):
    return {
        "key": key, "title": "Implement feature", "contractSummary": "Add feature",
        "paths": ["src/feature.py"], "criteria": ["Feature works"],
        "dependencies": dependencies or [],
    }


def proposal(tasks):
    return {"goal": "Build a feature", "summary": "Implement and verify", "tasks": tasks}


class PlanValidationTests(unittest.TestCase):
    def test_valid_graph_allows_forward_references_and_shared_dependencies(self):
        value = PlanProposal.model_validate(proposal([
            task("verify", ["ui", "api"]), task("ui", ["base"]),
            task("api", ["base"]), task("base"),
        ]))
        self.assertEqual(value.tasks[0].dependencies, ["api", "ui"])
        self.assertEqual(PlanProposal.model_validate_json(value.model_dump_json()), value)

    def test_invalid_graphs(self):
        cases = [
            [task("a"), task("a")],
            [task("a", ["missing"])],
            [task("a", ["a"])],
            [task("a", ["b"]), task("b", ["c"]), task("c", ["a"])],
            [task("a"), task("b", ["a", "a"])],
        ]
        for tasks in cases:
            with self.subTest(tasks=tasks), self.assertRaises(ValidationError):
                PlanProposal.model_validate(proposal(tasks))

    def test_model_cannot_assign_or_approve_work(self):
        for key, value in [("agentId", str(uuid4())), ("status", "approved"),
                           ("created_by", str(uuid4()))]:
            body = task("a") | {key: value}
            with self.subTest(field=key), self.assertRaises(ValidationError):
                PlanProposal.model_validate(proposal([body]))

    def test_invalid_scope_and_text(self):
        for key, value in [("paths", ["../secret"]), ("paths", ["/tmp/file"]),
                           ("criteria", []), ("criteria", [" "]),
                           ("criteria", ["bad\x00text"]), ("title", " "),
                           ("description", "bad\x00text"), ("key", "bad key")]:
            with self.subTest(field=key, value=value), self.assertRaises(ValidationError):
                PlanProposal.model_validate(proposal([task("a") | {key: value}]))

    def test_bounds_and_blank_goal(self):
        for tasks in [[], [task(f"task{i}") for i in range(51)]]:
            with self.assertRaises(ValidationError):
                PlanProposal.model_validate(proposal(tasks))
        with self.assertRaises(ValidationError):
            PlanProposal.model_validate(proposal([task("a")]) | {"goal": "  "})

    def test_revision_requires_real_positive_versions(self):
        body = {"operationId": str(uuid4()), "expectedVersion": 1,
                "expectedPlanVersion": 1, "proposal": proposal([task("a")])}
        RevisePlanRequest.model_validate(body)
        for field in ["expectedVersion", "expectedPlanVersion"]:
            for value in [True, 0, "1"]:
                with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                    RevisePlanRequest.model_validate(body | {field: value})
