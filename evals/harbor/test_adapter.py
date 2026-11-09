import asyncio
import hashlib
import json
import io
import os
import tempfile
import tarfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from ligule_agent import (
    APT_SOURCES_TARGET,
    LiguleAgent,
    NODE_RUNTIME_TARBALL_TARGET,
    TARBALL_TARGET,
    release_manifest,
)

TEMP_ROOT = Path(os.environ.get("LIGULE_EVAL_TEMP_DIR", Path(__file__).resolve().parents[3] / "testplace" / "tmp"))
COMPOSE_PROVIDER_BANNER = "\x1b[4m>>>> Executing external compose provider 'podman-compose' <<<<\n\x1b[0m"


def make_tarball(path: Path, manifest: dict[str, str]) -> None:
    content = json.dumps(manifest).encode("utf-8")
    with tarfile.open(path, "w:gz") as archive:
        item = tarfile.TarInfo("package/package.json")
        item.size = len(content)
        archive.addfile(item, io.BytesIO(content))


def make_node_runtime_tarball(path: Path) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name in (
            "node-v24.22.0-linux-x64/bin/node",
            "node-v24.22.0-linux-x64/bin/npm",
        ):
            item = tarfile.TarInfo(name)
            item.mode = 0o755
            item.size = 0
            archive.addfile(item, io.BytesIO())


class FakeEnvironment:
    default_user = "harbor-agent"

    def __init__(
        self,
        digest: str,
        *,
        occupied: bool = False,
        node_version: str | None = "v24.22.0",
        node_runtime_digest: str | None = None,
        node_runtime_directory_exists: bool = False,
        build_tools_installed: bool = True,
    ) -> None:
        self.digest = digest
        self.occupied = occupied
        self.node_version = node_version
        self.node_runtime_digest = node_runtime_digest
        self.node_runtime_extracted = False
        self.node_runtime_directory_exists = node_runtime_directory_exists
        self.build_tools_installed = build_tools_installed
        self.owner = "root"
        self.commands: list[tuple[str | int | None, str]] = []
        self.command_envs: list[tuple[str, dict[str, str]]] = []
        self.scoped_envs: list[dict[str, str]] = []
        self.uploads: list[str] = []

    @contextmanager
    def scoped_exec_env(self, env: dict[str, str]):
        self.scoped_envs.append(dict(env))
        try:
            yield
        finally:
            self.scoped_envs.pop()

    async def exec(self, *, command: str, user: str | int | None = None, **_kwargs: object) -> SimpleNamespace:
        self.commands.append((user, command))
        text = command.split("set -o pipefail; ", 1)[-1]
        command_env = _kwargs.get("env")
        merged_env = dict(command_env) if isinstance(command_env, dict) else {}
        for scoped_env in self.scoped_envs:
            merged_env.update(scoped_env)
        self.command_envs.append((
            text,
            merged_env,
        ))
        if user == "root":
            if "apt-get" in text and "build-essential python3" in text:
                self.build_tools_installed = True
                return SimpleNamespace(return_code=0, stdout="", stderr="")
            if "/installed-agent" not in text or "chown -- harbor-agent /installed-agent" not in text:
                return SimpleNamespace(return_code=1, stdout="", stderr="unexpected root write")
            if "-R" in text or self.occupied:
                return SimpleNamespace(return_code=1, stdout="", stderr="install prefix is not empty")
            self.owner = "harbor-agent"
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        actor = self.default_user if user is None else str(user)
        if text == "mkdir -m 700 /installed-agent/node-runtime":
            if self.node_runtime_directory_exists:
                return SimpleNamespace(return_code=1, stdout="", stderr="File exists")
            self.node_runtime_directory_exists = True
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if "command -v make" in text or "command -v g++" in text:
            code = 0 if self.build_tools_installed else 1
            return SimpleNamespace(return_code=code, stdout="", stderr="")
        if "command -v python3" in text:
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if "node --version && npm --version" in text:
            if "/installed-agent/node-runtime" in text and self.node_runtime_extracted:
                return SimpleNamespace(
                    return_code=0,
                    stdout=f"{COMPOSE_PROVIDER_BANNER}v24.22.0\n11.0.0\n",
                    stderr="",
                )
            if self.node_version is None:
                return SimpleNamespace(
                    return_code=0, stdout=COMPOSE_PROVIDER_BANNER, stderr="node: not found"
                )
            return SimpleNamespace(
                return_code=0,
                stdout=f"{COMPOSE_PROVIDER_BANNER}{self.node_version}\n11.0.0\n",
                stderr="",
            )
        if f"sha256sum {NODE_RUNTIME_TARBALL_TARGET}" in text:
            digest = self.node_runtime_digest or ""
            return SimpleNamespace(
                return_code=0,
                stdout=f"{COMPOSE_PROVIDER_BANNER}{digest}  {NODE_RUNTIME_TARBALL_TARGET}\n",
                stderr="",
            )
        if "tar" in text and "/installed-agent/node-runtime" in text:
            self.node_runtime_extracted = True
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if "test -w /installed-agent" in text:
            code = 0 if self.owner == actor else 1
            return SimpleNamespace(return_code=code, stdout="", stderr="")
        if "node -e" in text:
            return SimpleNamespace(
                return_code=0, stdout=f"{COMPOSE_PROVIDER_BANNER}{self.digest}\n", stderr=""
            )
        if text.startswith("npm install --prefix /installed-agent"):
            code = 0 if self.owner == actor else 1
            return SimpleNamespace(return_code=code, stdout="installed\n" if code == 0 else "", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


class HarborAdapterTests(unittest.TestCase):
    def test_tarball_identity_is_read_from_the_supplied_archive(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            info = release_manifest(tarball)
            self.assertEqual(info["name"], "ligule")
            self.assertEqual(info["version"], "0.1.1-dev")
            self.assertEqual(len(info["sha256"]), 64)

    def test_adapter_uses_harbor_025_capability_and_tarball_version(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )
            self.assertEqual(agent.name(), "ligule")
            self.assertEqual(agent.version(), "0.1.1-dev")
            self.assertTrue(agent.capabilities.atif)
            self.assertEqual(agent.ligule_model, "test-model")

    def test_run_budgets_must_be_positive_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            with self.assertRaisesRegex(ValueError, "model_calls_out_of_range"):
                LiguleAgent(
                    logs_dir=Path(directory) / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_model_calls=0,
                )
            with self.assertRaisesRegex(ValueError, "output_tokens_out_of_range"):
                LiguleAgent(
                    logs_dir=Path(directory) / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_output_tokens=0,
                )
            with self.assertRaisesRegex(ValueError, "ligule_policy_mode_invalid"):
                LiguleAgent(
                    logs_dir=Path(directory) / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_policy_mode="ask",
                )

    def test_setup_proxy_url_rejects_embedded_credentials(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            with self.assertRaisesRegex(ValueError, "ligule_setup_proxy_url_invalid"):
                LiguleAgent(
                    logs_dir=Path(directory) / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_setup_proxy_url="http://proxy-user:test-only@proxy.example.test:8080",
                )

    def test_non_root_install_owns_only_the_empty_install_prefix(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                if environment.owner != environment.default_user:
                    raise PermissionError("install directory was not prepared for the agent user")
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            environment = FakeEnvironment(agent.package["sha256"])
            asyncio.run(agent.install(environment))

            root_commands = [command for user, command in environment.commands if user == "root"]
            self.assertEqual(len(root_commands), 1)
            self.assertIn("chown -- harbor-agent /installed-agent", root_commands[0])
            self.assertIn("chmod 0755 /installed-agent", root_commands[0])
            self.assertNotIn("chown -R", root_commands[0])
            self.assertEqual(environment.uploads, [TARBALL_TARGET])
            self.assertTrue(any(command.split("set -o pipefail; ", 1)[-1].startswith(
                "npm install --prefix /installed-agent") for _user, command in environment.commands))

    def test_nonempty_install_prefix_is_refused_without_recursive_chown(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )
            environment = FakeEnvironment(agent.package["sha256"], occupied=True)
            with self.assertRaises(RuntimeError):
                asyncio.run(agent.install(environment))
            self.assertEqual(environment.uploads, [])
            self.assertFalse(any("npm install --prefix /installed-agent" in command
                                 for _user, command in environment.commands))

    def test_install_can_add_native_build_tools_when_the_task_image_lacks_them(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                extra_env={"LIGULE_API_KEY": "test-only"},
                ligule_install_build_tools=True,
                ligule_setup_proxy_url="http://host.containers.internal:19676",
                ligule_setup_apt_mirror="tsinghua",
            )
            environment = FakeEnvironment(
                agent.package["sha256"], build_tools_installed=False
            )

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            asyncio.run(agent.setup(environment))

            root_commands = [command for user, command in environment.commands if user == "root"]
            self.assertTrue(any(
                "apt-get" in command and " update" in command
                for command in root_commands
            ))
            self.assertTrue(any(
                "mirrors.tuna.tsinghua.edu.cn/debian" in command
                and "mirrors.tuna.tsinghua.edu.cn/ubuntu" in command
                and "Dir::Etc::sourcelist" in command
                and APT_SOURCES_TARGET in command
                for command in root_commands
            ))
            apt_env = next(
                env for command, env in environment.command_envs
                if "apt-get" in command and "build-essential python3" in command
            )
            self.assertEqual(apt_env["HTTPS_PROXY"], "http://host.containers.internal:19676")
            self.assertEqual(apt_env["LIGULE_API_KEY"], "")
            npm_env = next(
                env for command, env in environment.command_envs
                if "npm install --prefix /installed-agent" in command
            )
            self.assertNotIn("HTTPS_PROXY", npm_env)
            self.assertTrue(all(
                "HTTPS_PROXY" not in env and "HTTP_PROXY" not in env
                for command, env in environment.command_envs
                if not ("apt-get" in command and "build-essential python3" in command)
            ))
            tool_check = next(
                index for index, (_user, command) in enumerate(environment.commands)
                if "command -v make" in command
            )
            package_install = next(
                index for index, (_user, command) in enumerate(environment.commands)
                if "npm install --prefix /installed-agent" in command
            )
            self.assertLess(tool_check, package_install)
            self.assertIn(TARBALL_TARGET, environment.uploads)
            self.assertTrue(environment.build_tools_installed)

    def test_install_uses_the_pinned_node_runtime_when_the_task_image_has_no_node(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            runtime_tarball = root / "node-v24.22.0-linux-x64.tar.gz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            make_node_runtime_tarball(runtime_tarball)
            runtime_sha256 = hashlib.sha256(runtime_tarball.read_bytes()).hexdigest()
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                ligule_node_runtime_tarball=str(runtime_tarball),
                ligule_node_runtime_sha256=runtime_sha256,
            )
            environment = FakeEnvironment(
                agent.package["sha256"], node_version=None, node_runtime_digest=runtime_sha256
            )
            uploaded: list[tuple[Path, str]] = []

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                if environment.owner != environment.default_user:
                    raise PermissionError("install directory was not prepared for the agent user")
                environment.uploads.append(target)
                uploaded.append((Path(source), target))

            agent._upload_agent_owned_file = record_upload
            asyncio.run(agent.install(environment))

            self.assertTrue(any(source == runtime_tarball for source, _target in uploaded))
            self.assertTrue(any("tar" in command and "/installed-agent/node-runtime" in command
                                for _user, command in environment.commands))
            runtime_commands = [
                command
                for _user, command in environment.commands
                if "npm install --prefix /installed-agent" in command or "node -e" in command
            ]
            self.assertEqual(len(runtime_commands), 2)
            for command in runtime_commands:
                self.assertIn("/installed-agent/node-runtime/bin", command)

    def test_setup_masks_the_provider_key_from_install_commands(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                extra_env={"LIGULE_API_KEY": "test-only"},
                environment_logs_dir=Path("/logs/agent"),
                ligule_setup_proxy_url="http://host.containers.internal:19676",
            )
            environment = FakeEnvironment(agent.package["sha256"])

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            asyncio.run(agent.setup(environment))

            self.assertTrue(environment.commands)
            self.assertTrue(all(
                env.get("LIGULE_API_KEY") == ""
                for _command, env in environment.command_envs
            ))

    def test_install_uses_the_pinned_node_runtime_when_the_task_image_has_old_node(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            runtime_tarball = root / "node-v24.22.0-linux-x64.tar.gz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            make_node_runtime_tarball(runtime_tarball)
            runtime_sha256 = hashlib.sha256(runtime_tarball.read_bytes()).hexdigest()
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                ligule_node_runtime_tarball=str(runtime_tarball),
                ligule_node_runtime_sha256=runtime_sha256,
            )
            environment = FakeEnvironment(
                agent.package["sha256"], node_version="v18.20.0", node_runtime_digest=runtime_sha256
            )
            uploads: list[str] = []

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                if environment.owner != environment.default_user:
                    raise PermissionError("install directory was not prepared for the agent user")
                uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            asyncio.run(agent.install(environment))

            self.assertIn(NODE_RUNTIME_TARBALL_TARGET, uploads)
            self.assertTrue(environment.node_runtime_extracted)

    def test_install_refuses_a_preexisting_node_runtime_directory(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            runtime_tarball = root / "node-v24.22.0-linux-x64.tar.gz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            make_node_runtime_tarball(runtime_tarball)
            runtime_sha256 = hashlib.sha256(runtime_tarball.read_bytes()).hexdigest()
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                ligule_node_runtime_tarball=str(runtime_tarball),
                ligule_node_runtime_sha256=runtime_sha256,
            )
            environment = FakeEnvironment(
                agent.package["sha256"], node_version=None,
                node_runtime_directory_exists=True,
            )

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            with self.assertRaises(RuntimeError):
                asyncio.run(agent.install(environment))

            self.assertEqual(environment.uploads, [])
            self.assertFalse(environment.node_runtime_extracted)

    def test_install_rejects_a_remote_node_runtime_sha_mismatch_without_extracting(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            runtime_tarball = root / "node-v24.22.0-linux-x64.tar.gz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            make_node_runtime_tarball(runtime_tarball)
            runtime_sha256 = hashlib.sha256(runtime_tarball.read_bytes()).hexdigest()
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                ligule_node_runtime_tarball=str(runtime_tarball),
                ligule_node_runtime_sha256=runtime_sha256,
            )
            environment = FakeEnvironment(
                agent.package["sha256"], node_version=None, node_runtime_digest="0" * 64
            )

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            with self.assertRaisesRegex(RuntimeError, "ligule_node_runtime_upload_sha256_mismatch"):
                asyncio.run(agent.install(environment))

            self.assertEqual(environment.uploads, [NODE_RUNTIME_TARBALL_TARGET])
            self.assertFalse(environment.node_runtime_extracted)
            self.assertFalse(any(target == TARBALL_TARGET for target in environment.uploads))

    def test_local_node_runtime_sha_mismatch_is_rejected_during_configuration(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            runtime_tarball = root / "node-v24.22.0-linux-x64.tar.gz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            make_node_runtime_tarball(runtime_tarball)

            with self.assertRaisesRegex(ValueError, "ligule_node_runtime_sha256_mismatch"):
                LiguleAgent(
                    logs_dir=root / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_node_runtime_tarball=str(runtime_tarball),
                    ligule_node_runtime_sha256="0" * 64,
                )

    def test_run_uses_the_installed_node_runtime_path(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            root = Path(directory)
            tarball = root / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=root / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
                extra_env={"LIGULE_API_KEY": "test-only"},
                environment_logs_dir=Path("/logs/agent"),
                ligule_output_tokens=16_384,
                ligule_policy_mode="auto",
            )
            agent.node_bin_directory = "/installed-agent/node-runtime/bin"
            environment = FakeEnvironment(agent.package["sha256"])
            commands: list[str] = []
            command_envs: list[dict[str, str]] = []

            async def capture_exec(
                environment: FakeEnvironment,
                *,
                command: str,
                env: dict[str, str] | None = None,
                **_kwargs: object,
            ) -> SimpleNamespace:
                commands.append(command)
                merged_env = dict(env) if env is not None else {}
                for scoped_env in environment.scoped_envs:
                    merged_env.update(scoped_env)
                command_envs.append(merged_env)
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def capture_upload(environment: object, source: Path, target: str) -> None:
                return None

            agent.exec_as_agent = capture_exec
            agent._upload_agent_owned_file = capture_upload
            asyncio.run(agent.run("complete the task", environment, SimpleNamespace()))

            node_commands = [command for command in commands if "export PATH=" in command]
            self.assertEqual(len(node_commands), 1)
            self.assertIn("export PATH=/installed-agent/node-runtime/bin", node_commands[0])
            self.assertIn("/installed-agent/node_modules/ligule/export_session.mjs", node_commands[0])
            self.assertIn("--output-tokens 16384", node_commands[0])
            self.assertIn("--policy-mode auto", node_commands[0])
            self.assertEqual(len(command_envs), 2)
            self.assertEqual(command_envs[0].get("LIGULE_API_KEY"), "")
            self.assertEqual(command_envs[1].get("LIGULE_API_KEY"), "test-only")
            self.assertTrue(all(
                "HTTP_PROXY" not in env and "HTTPS_PROXY" not in env
                for env in command_envs
            ))


if __name__ == "__main__":
    unittest.main()
