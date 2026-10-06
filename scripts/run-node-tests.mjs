import { spawnSync } from "node:child_process";

const groups = {
  unit: [
    "tests/audit-fixes.test.ts",
    "tests/editor-hot-path.test.ts",
    "tests/region-catalog.test.ts",
    "tests/credits.test.ts",
    "tests/cleaning-device.test.ts",
    "tests/work-credit.test.ts",
    "tests/provider-catalog.test.ts",
    "tests/effective-translate.test.ts",
    "tests/detector-config.test.ts",
    "tests/detect-fusion.test.ts",
    "tests/detection-geometry.test.ts",
    "tests/remote-providers.test.ts",
    "tests/kana-chart.test.ts",
    "tests/nvtop-usage.test.ts",
    "tests/nvtop-build.test.ts",
    "tests/mmproj-device.test.ts",
    "tests/gpu-names.test.ts",
    "tests/image-edit-placement.test.ts",
  ],
  integration: [
    "tests/model-packages.test.ts",
    "tests/model-capabilities.test.ts",
    "tests/workflow.test.ts",
    "tests/scanlator-access.test.ts",
    "tests/signed-in.test.ts",
    "tests/proofreader-access.test.ts",
    "tests/fresh-install.test.ts",
    "tests/setup-report.test.ts",
    "tests/setup-install.test.ts",
    "tests/http-endpoint-contract.test.ts",
  ],
};

const group = process.argv[2];
const files = groups[group];
if (!files) {
  console.error(`Usage: node scripts/run-node-tests.mjs <unit|integration>`);
  process.exit(2);
}

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status) process.exit(result.status ?? 1);
}
