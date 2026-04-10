import fs from "fs-extra";
import os from "os";
import path from "path";
import { spawn } from "child_process";

function hasArg(args, flag) {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function resolveTauriBinary() {
  const binName = process.platform === "win32" ? "tauri.cmd" : "tauri";
  return path.join(process.cwd(), "node_modules", ".bin", binName);
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const command = cliArgs[0];
  const tauriBinary = resolveTauriBinary();
  const spawnedArgs = [...cliArgs];
  let tempConfigPath;

  if (command === "build" && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
    const overrideConfig = {
      bundle: {
        targets: ["app"],
        createUpdaterArtifacts: false,
      },
    };

    tempConfigPath = path.join(
      os.tmpdir(),
      `tauri.local.${process.pid}.${Date.now()}.json`
    );
    await fs.writeJson(tempConfigPath, overrideConfig, { spaces: 2 });

    if (!hasArg(spawnedArgs, "--bundles")) {
      spawnedArgs.push("--bundles", "app");
    }
    if (!hasArg(spawnedArgs, "--config")) {
      spawnedArgs.push("--config", tempConfigPath);
    }

    console.log(
      "TAURI_SIGNING_PRIVATE_KEY 未设置，使用本地构建模式：仅打包 .app，并跳过 updater artifacts。"
    );
  }

  const child = spawn(tauriBinary, spawnedArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", async (code, signal) => {
    if (tempConfigPath) {
      await fs.remove(tempConfigPath);
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", async (error) => {
    if (tempConfigPath) {
      await fs.remove(tempConfigPath);
    }
    console.error(error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
