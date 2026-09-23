// ============================================================
// Speed Stack eval harness: CLI entry
// ============================================================
//
// Run from apps/zcode-cli/packages/core:
//   tsx src/speedstack/eval/run.ts [policy|smoke|replay] [options]
//
// Options:
//   --offline                  use checked-in route fixtures (deterministic)
//   --route-fixture <file>      custom route fixture (implies --offline)
//   --schema-sizes <file>       tool schema sizes (default: checked-in)
//   --simulate <file>           JSON {taskId:{steps,toolCalls}} for the tune loop
//   --run <report.json>        replay mode input
//   --out <file>               write JSON report (default: stdout)
//   --shim <url>                SystemOne route endpoint override
//   --budget <t>:<s>:<c>       per-run budget override, repeatable
//                              (t=economy|balanced|heavy, "-" = unbounded)
//   --budget-default <s>:<c>    default budget override
//   --help
//
// Full docs: eval/README.md. The tune loop:
//   tsx src/speedstack/eval/run.ts policy --simulate usage.json \
//     --budget economy:25:60 --budget balanced:40:100 --budget heavy:80:200

import {
  printSummary,
  runPolicyMode,
  runReplayMode,
  runSmokeMode,
  SYSTEMONE_ROUTE_ENDPOINT,
  writeReport,
  type HarnessMode,
  type HarnessOptions,
} from "./harness.js";

function usage(): string {
  return [
    "usage: tsx src/speedstack/eval/run.ts [policy|smoke|replay] [options]",
    "",
    "  policy   route + tool-pack + budget measurement (default)",
    "  smoke    verify SystemOne shim + LM Studio answer (no inference)",
    "  replay   re-evaluate a report's usage against new --budget flags",
    "",
    "  --offline                  use checked-in route fixtures",
    "  --route-fixture <file>      custom fixtures (implies --offline)",
    "  --schema-sizes <file>       tool schema sizes JSON",
    "  --simulate <file>           JSON {taskId:{steps,toolCalls}}",
    "  --run <report.json>         replay input",
    "  --out <file>               write report JSON (default: stdout)",
    "  --shim <url>               route endpoint override",
    "  --budget <t>:<s>:<c>       per-run budget override (repeatable)",
    "  --budget-default <s>:<c>   default budget override",
    "  --help                     this text",
  ].join("\n");
}

function parseArgs(argv: string[]): HarnessOptions {
  let mode: HarnessMode = "policy";
  const options: HarnessOptions = {
    mode,
    offline: false,
    shimEndpoint: SYSTEMONE_ROUTE_ENDPOINT,
    budgetFlags: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1] as string | undefined;
    const takeNext = (): string => {
      if (next === undefined) throw new Error(`${arg} expects a value`);
      i++;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--offline":
        options.offline = true;
        break;
      case "--route-fixture":
        options.routeFixturePath = takeNext();
        options.offline = true;
        break;
      case "--schema-sizes":
        options.schemaSizesPath = takeNext();
        break;
      case "--simulate":
        options.simulatePath = takeNext();
        break;
      case "--run":
        options.runPath = takeNext();
        break;
      case "--out":
        options.outPath = takeNext();
        break;
      case "--shim":
        options.shimEndpoint = takeNext();
        break;
      case "--budget":
        options.budgetFlags.push(takeNext());
        break;
      case "--budget-default":
        options.budgetDefaultFlag = takeNext();
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`too many positional args: ${positional.join(" ")}`);
  if (positional.length === 1) {
    const candidate = positional[0] as string;
    if (candidate !== "policy" && candidate !== "smoke" && candidate !== "replay") {
      throw new Error(`unknown mode ${JSON.stringify(candidate)}`);
    }
    mode = candidate;
    options.mode = mode;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report =
    options.mode === "smoke"
      ? await runSmokeMode(options)
      : options.mode === "replay"
        ? await runReplayMode(options)
        : await runPolicyMode(options);
  printSummary(report);
  writeReport(report, options.outPath);
}

main().catch((error) => {
  console.error(`harness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
