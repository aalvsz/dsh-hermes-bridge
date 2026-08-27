#!/usr/bin/env python3
"""JSON-lines adapter from DeepSeek Harness into an installed Hermes Agent runtime.

Hermes remains the implementation and state owner. This bridge imports the
installed checkout, projects its live tool catalog, dispatches its registered
tools, and embeds documented AIAgent runs. It does not copy credentials or
reimplement Hermes behavior.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib
import traceback
from typing import Any, Dict, Iterable


class HermesRuntime:
    def __init__(self, agent_root: Path, hermes_home: Path) -> None:
        self.agent_root = agent_root.resolve(strict=True)
        requested_home = hermes_home.expanduser().absolute()
        if requested_home.is_symlink():
            raise ValueError("HERMES_HOME must not be a symbolic link")
        self.hermes_home = requested_home.resolve()
        self._validate_root()
        self.hermes_home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._validate_private_home()
        os.environ["HERMES_HOME"] = str(self.hermes_home)
        sys.path.insert(0, str(self.agent_root))

        from jsonschema import Draft202012Validator  # pylint: disable=import-outside-toplevel
        from jsonschema.exceptions import ValidationError  # pylint: disable=import-outside-toplevel
        from model_tools import (  # pylint: disable=import-outside-toplevel
            get_tool_definitions,
            handle_function_call,
            registry,
        )
        from tools.memory_tool import (  # pylint: disable=import-outside-toplevel
            MEMORY_SCHEMA,
            _build_memory_schema_overrides,
            load_on_disk_store,
            memory_tool,
        )
        from tools.skill_manager_tool import (  # pylint: disable=import-outside-toplevel
            SKILL_MANAGE_SCHEMA,
            _reset_background_review_read_marks,
            mark_background_review_skill_read,
            skill_manage,
        )
        from tools.skills_tool import (  # pylint: disable=import-outside-toplevel
            SKILLS_LIST_SCHEMA,
            SKILL_VIEW_SCHEMA,
            _skill_view_with_bump,
            skills_list,
        )
        from tools.skill_provenance import (  # pylint: disable=import-outside-toplevel
            reset_current_write_origin,
            set_current_write_origin,
        )
        from agent.background_review import (  # pylint: disable=import-outside-toplevel
            _COMBINED_REVIEW_PROMPT,
            _MEMORY_REVIEW_PROMPT,
            _SKILL_REVIEW_PROMPT,
            load_background_review_settings,
        )
        from agent.learn_prompt import build_learn_prompt  # pylint: disable=import-outside-toplevel
        from agent.prompt_builder import SKILLS_GUIDANCE  # pylint: disable=import-outside-toplevel

        self.json_schema_validator = Draft202012Validator
        self.json_schema_validation_error = ValidationError
        self.get_tool_definitions = get_tool_definitions
        self.handle_function_call = handle_function_call
        self.registry = registry
        self.memory_schema = MEMORY_SCHEMA
        self.build_memory_schema_overrides = _build_memory_schema_overrides
        self.load_on_disk_store = load_on_disk_store
        self.memory_tool = memory_tool
        self.skill_manage_schema = SKILL_MANAGE_SCHEMA
        self.skill_manage = skill_manage
        self.skill_view_schema = SKILL_VIEW_SCHEMA
        self.skills_list_schema = SKILLS_LIST_SCHEMA
        self.skill_view_with_bump = _skill_view_with_bump
        self.skills_list = skills_list
        self.reset_review_reads = _reset_background_review_read_marks
        self.mark_review_read = mark_background_review_skill_read
        self.set_write_origin = set_current_write_origin
        self.reset_write_origin = reset_current_write_origin
        self.skills_guidance = SKILLS_GUIDANCE
        self.memory_review_prompt = _MEMORY_REVIEW_PROMPT
        self.skill_review_prompt = _SKILL_REVIEW_PROMPT
        self.combined_review_prompt = _COMBINED_REVIEW_PROMPT
        self.load_background_review_settings = load_background_review_settings
        self.build_learn_prompt = build_learn_prompt
        self.stores: Dict[str, Any] = {}
        self.store_turns: Dict[str, Any] = {}

    def dispatch(self, request: Dict[str, Any]) -> Any:
        operation = request.get("op")
        if operation in {"bootstrap", "health", "status"}:
            if operation == "bootstrap":
                return self._bootstrap(request)
            return self._health()
        if operation == "snapshot":
            return self._snapshot(request)
        if operation == "memory":
            return self._memory(request)
        if operation == "skills_list":
            return self._skills_list(request)
        if operation == "skill_view":
            return self._skill_view(request)
        if operation == "skill_manage":
            return self._skill_manage(request)
        if operation == "learn_prompt":
            return {"prompt": self.build_learn_prompt(str(request.get("request") or ""))}
        if operation == "curator_if_due":
            return self._curator_if_due()
        if operation == "tool_call":
            return self._tool_call(request)
        if operation == "delegate":
            return self._delegate(request)
        raise ValueError(f"unknown bridge operation: {operation!r}")

    def _bootstrap(self, request: Dict[str, Any]) -> Dict[str, Any]:
        toolsets = self._string_list(request.get("toolsets"), ["all"])
        disabled = self._string_list(request.get("disabledToolsets"), [])
        override = self.build_memory_schema_overrides()
        memory_schema = dict(self.memory_schema)
        memory_schema["description"] = override["description"]
        memory_schema["parameters"] = override["parameters"]
        self.load_background_review_settings()  # feature probe; DSH owns review model routing
        config = self._load_config()
        memory_config = config.get("memory") if isinstance(config.get("memory"), dict) else {}
        skills_config = config.get("skills") if isinstance(config.get("skills"), dict) else {}
        tools = self.get_tool_definitions(
            enabled_toolsets=toolsets,
            disabled_toolsets=disabled,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
        return {
            "health": self._health(),
            "schemas": {
                "memory": memory_schema,
                "skills_list": self.skills_list_schema,
                "skill_view": self.skill_view_schema,
                "skill_manage": self.skill_manage_schema,
            },
            "guidance": self.skills_guidance,
            "reviewPrompts": {
                "memory": self.memory_review_prompt,
                "skills": self.skill_review_prompt,
                "combined": self.combined_review_prompt,
            },
            "settings": {
                "memoryNudgeInterval": self._positive_int(memory_config.get("nudge_interval"), 10),
                "skillNudgeInterval": self._positive_int(skills_config.get("creation_nudge_interval"), 10),
            },
            "native": {
                "memory": True,
                "skills": True,
                "backgroundReview": True,
            },
            "delegate": {"available": self._module_exists("run_agent.py")},
            "tools": tools,
            "toolsets": self._toolset_status(),
        }

    def _health(self) -> Dict[str, Any]:
        return {
            "implementation": "installed-hermes-python-runtime",
            "version": self._version(),
            "commit": self._commit(),
            "python": sys.version.split()[0],
        }

    def _snapshot(self, request: Dict[str, Any]) -> Dict[str, Any]:
        session_id = self._session_id(request)
        if request.get("refresh") or session_id not in self.stores:
            self.stores[session_id] = self.load_on_disk_store()
            self.store_turns.pop(session_id, None)
        store = self.stores[session_id]
        memory = store.format_for_system_prompt("memory") or ""
        user = store.format_for_system_prompt("user") or ""
        return {
            "sessionId": session_id,
            "memory": memory,
            "user": user,
            "text": "\n\n".join(part for part in (memory, user) if part),
            "memoryLimit": store.memory_char_limit,
            "userLimit": store.user_char_limit,
        }

    def _memory(self, request: Dict[str, Any]) -> Dict[str, Any]:
        session_id = self._session_id(request)
        store = self.stores.get(session_id)
        if store is None:
            store = self.load_on_disk_store()
            self.stores[session_id] = store
        turn = request.get("turn")
        if self.store_turns.get(session_id) != turn:
            store.reset_consolidation_failures()
            self.store_turns[session_id] = turn
        arguments = self._arguments(request)
        return self._parse_tool_json(self.memory_tool(
            action=arguments.get("action"),
            target=arguments.get("target", "memory"),
            content=arguments.get("content"),
            old_text=arguments.get("old_text"),
            new_text=arguments.get("new_text"),
            operations=arguments.get("operations"),
            store=store,
        ))

    def _skills_list(self, request: Dict[str, Any]) -> Any:
        arguments = self._arguments(request)
        return self._parse_json_if_possible(self.skills_list(
            category=arguments.get("category"),
            task_id=self._session_id(request),
        ))

    def _skill_view(self, request: Dict[str, Any]) -> Any:
        arguments = self._arguments(request)
        session_id = self._session_id(request)
        origin = self._origin(request)
        token = self._prepare_origin(origin, session_id)
        try:
            return self._parse_json_if_possible(self.skill_view_with_bump(
                arguments,
                task_id=session_id,
                session_id=session_id,
            ))
        finally:
            self.reset_write_origin(token)

    def _skill_manage(self, request: Dict[str, Any]) -> Any:
        arguments = self._arguments(request)
        session_id = self._session_id(request)
        token = self._prepare_origin(
            self._origin(request),
            session_id,
            self._string_list(request.get("reviewReadPaths"), []),
        )
        try:
            return self._parse_json_if_possible(self.skill_manage(
                action=arguments.get("action", ""),
                name=arguments.get("name", ""),
                content=arguments.get("content"),
                category=arguments.get("category"),
                file_path=arguments.get("file_path"),
                file_content=arguments.get("file_content"),
                old_string=arguments.get("old_string"),
                new_string=arguments.get("new_string"),
                replace_all=bool(arguments.get("replace_all", False)),
                absorbed_into=arguments.get("absorbed_into"),
                task_id=session_id,
                session_id=session_id,
            ))
        finally:
            self.reset_write_origin(token)

    def _tool_call(self, request: Dict[str, Any]) -> Any:
        name = str(request.get("name") or "")
        if not name or len(name) > 200:
            raise ValueError("tool name is required and must be at most 200 characters")
        arguments = self._arguments(request)
        toolsets = self._string_list(request.get("toolsets"), ["all"])
        disabled = self._string_list(request.get("disabledToolsets"), [])
        definitions = self.get_tool_definitions(
            enabled_toolsets=toolsets,
            disabled_toolsets=disabled,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
        enabled_names = [item.get("function", {}).get("name") for item in definitions]
        if name not in enabled_names:
            raise PermissionError(f"Hermes tool {name!r} is not enabled for this bridge")
        definition = next(item["function"] for item in definitions if item.get("function", {}).get("name") == name)
        try:
            self.json_schema_validator(definition.get("parameters") or {}).validate(arguments)
        except self.json_schema_validation_error as error:
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            raise ValueError(f"invalid arguments for Hermes tool {name!r} at {location}: {error.message}") from error
        result = self.handle_function_call(
            function_name=name,
            function_args=arguments,
            task_id=self._session_id(request),
            session_id=self._session_id(request),
            user_task=str(request.get("userTask") or ""),
            enabled_tools=enabled_names,
            enabled_toolsets=toolsets,
            disabled_toolsets=disabled,
        )
        return self._parse_json_if_possible(result)

    def _delegate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        prompt = str(request.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("delegate prompt is required")
        if len(prompt) > 1_000_000:
            raise ValueError("delegate prompt is too large")
        from run_agent import AIAgent  # pylint: disable=import-outside-toplevel

        max_iterations = self._bounded_int(request.get("maxIterations"), 100, 1, 500)
        run_budget = self._bounded_float(request.get("runBudgetSeconds"), 900.0, 1.0, 86_400.0)
        kwargs: Dict[str, Any] = {
            "quiet_mode": True,
            "enabled_toolsets": self._string_list(request.get("toolsets"), ["all"]),
            "disabled_toolsets": self._string_list(request.get("disabledToolsets"), []),
            "max_iterations": max_iterations,
            "run_budget_seconds": run_budget,
            "session_id": self._session_id(request),
            "pass_session_id": True,
            "skip_context_files": bool(request.get("skipContextFiles", False)),
            "skip_memory": bool(request.get("skipMemory", False)),
        }
        for key, target in (("model", "model"), ("provider", "provider"), ("systemPrompt", "ephemeral_system_prompt")):
            value = request.get(key)
            if isinstance(value, str) and value.strip():
                kwargs[target] = value.strip()
        cwd = request.get("cwd")
        allowed_cwds = self._string_list(request.get("allowedCwds"), [str(Path.cwd())])
        with self._working_directory(cwd, allowed_cwds):
            agent = AIAgent(**kwargs)
            result = agent.run_conversation(prompt, task_id=self._session_id(request))
        return {
            "finalResponse": result.get("final_response", ""),
            "messages": result.get("messages", []),
            "sessionId": self._session_id(request),
        }

    def _curator_if_due(self) -> Dict[str, Any]:
        from agent.curator import run_curator_review, should_run_now  # pylint: disable=import-outside-toplevel
        if not should_run_now():
            return {"started": False, "reason": "not-due"}
        return {"started": True, "result": run_curator_review(synchronous=True)}

    def _prepare_origin(
        self,
        origin: str,
        _session_id: str,
        read_paths: list[str] | None = None,
    ) -> Any:
        token = self.set_write_origin(origin)
        if origin == "background_review":
            self.reset_review_reads()
            for path in sorted(set(read_paths or [])):
                self.mark_review_read(Path(path))
        return token

    def _toolset_status(self) -> Dict[str, Dict[str, Any]]:
        try:
            statuses = self.registry.check_toolset_requirements()
        except Exception as error:  # pragma: no cover - defensive against upstream drift
            return {"registry": {"available": False, "reason": f"{type(error).__name__}: {error}"}}
        return {name: {"available": bool(available)} for name, available in sorted(statuses.items())}

    def _load_config(self) -> Dict[str, Any]:
        try:
            from hermes_cli.config import load_config_readonly  # pylint: disable=import-outside-toplevel
            config = load_config_readonly()
            return config if isinstance(config, dict) else {}
        except Exception:
            return {}

    def _version(self) -> str:
        try:
            with (self.agent_root / "pyproject.toml").open("rb") as handle:
                value = tomllib.load(handle).get("project", {}).get("version")
            return str(value or "unknown")
        except Exception:
            return "unknown"

    def _commit(self) -> str:
        try:
            return subprocess.run(
                ["git", "-C", str(self.agent_root), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout.strip()
        except Exception:
            return "unknown"

    def _validate_root(self) -> None:
        required = ["pyproject.toml", "run_agent.py", "model_tools.py", "tools/registry.py"]
        missing = [path for path in required if not (self.agent_root / path).is_file()]
        if missing:
            raise ValueError(f"not a Hermes Agent checkout; missing: {', '.join(missing)}")

    def _module_exists(self, relative: str) -> bool:
        return (self.agent_root / relative).is_file()

    def _validate_private_home(self) -> None:
        status = self.hermes_home.stat()
        if hasattr(os, "getuid") and status.st_uid != os.getuid():
            raise PermissionError("HERMES_HOME must be owned by the current user")
        if status.st_mode & 0o022:
            raise PermissionError("HERMES_HOME must not be writable by group or other users")

    @contextlib.contextmanager
    def _working_directory(self, requested: Any, allowed_values: list[str]):
        previous = Path.cwd().resolve(strict=True)
        allowed = [Path(value).expanduser().resolve(strict=True) for value in allowed_values]
        target = previous
        if isinstance(requested, str) and requested.strip():
            target = Path(requested).expanduser().resolve(strict=True)
        if not target.is_dir():
            raise ValueError("delegate cwd is not a directory")
        if not any(target == root or target.is_relative_to(root) for root in allowed):
            raise PermissionError("delegate cwd is outside the configured delegateRoots")
        os.chdir(target)
        try:
            yield
        finally:
            os.chdir(previous)

    @staticmethod
    def _positive_int(value: Any, fallback: int) -> int:
        try:
            parsed = int(value)
            return parsed if parsed >= 0 else fallback
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _bounded_int(value: Any, fallback: int, low: int, high: int) -> int:
        try:
            parsed = int(value if value is not None else fallback)
        except (TypeError, ValueError) as error:
            raise ValueError("expected an integer") from error
        if parsed < low or parsed > high:
            raise ValueError(f"integer must be between {low} and {high}")
        return parsed

    @staticmethod
    def _bounded_float(value: Any, fallback: float, low: float, high: float) -> float:
        try:
            parsed = float(value if value is not None else fallback)
        except (TypeError, ValueError) as error:
            raise ValueError("expected a number") from error
        if parsed < low or parsed > high:
            raise ValueError(f"number must be between {low} and {high}")
        return parsed

    @staticmethod
    def _parse_tool_json(value: Any) -> Dict[str, Any]:
        parsed = json.loads(value) if isinstance(value, str) else value
        if not isinstance(parsed, dict):
            raise TypeError("Hermes tool returned a non-object result")
        return parsed

    @staticmethod
    def _parse_json_if_possible(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value

    @staticmethod
    def _arguments(request: Dict[str, Any]) -> Dict[str, Any]:
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            raise TypeError("arguments must be an object")
        return arguments

    @staticmethod
    def _session_id(request: Dict[str, Any]) -> str:
        value = str(request.get("sessionId") or "dsh-hermes-bridge")
        if len(value) > 256:
            raise ValueError("sessionId is too long")
        return value

    @staticmethod
    def _origin(request: Dict[str, Any]) -> str:
        return "background_review" if request.get("origin") == "background_review" else "foreground"

    @staticmethod
    def _string_list(value: Any, fallback: Iterable[str]) -> list[str]:
        if value is None:
            return list(fallback)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            raise TypeError("toolsets must be a list of non-empty strings")
        return list(dict.fromkeys(item.strip() for item in value))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--hermes-home", required=True)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def execute(runtime: HermesRuntime, request: Dict[str, Any]) -> Dict[str, Any]:
    request_id = request.get("id")
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            result = runtime.dispatch(request)
        return {"id": request_id, "ok": True, "result": result}
    except Exception as error:  # fail loud at the JSON boundary
        traceback.print_exc(file=sys.stderr)
        return {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}


def main() -> int:
    args = parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        runtime = HermesRuntime(Path(args.agent_root), Path(args.hermes_home))
    if args.once:
        request = json.loads(sys.stdin.read())
        sys.__stdout__.write(json.dumps(execute(runtime, request), ensure_ascii=False) + "\n")
        sys.__stdout__.flush()
        return 0
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            response = {"id": None, "ok": False, "error": f"invalid request: {error}"}
        else:
            response = execute(runtime, request)
        sys.__stdout__.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.__stdout__.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
