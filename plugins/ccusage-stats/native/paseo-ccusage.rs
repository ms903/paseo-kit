// This entry point builds inside the pinned upstream ccusage workspace.
mod cli;

use ccusage_cli::{Command, DEFAULT_SESSION_DURATION_HOURS};
use ccusage_core::{Result, cli_error, pricing};

#[cfg(all(target_os = "linux", target_env = "musl"))]
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> Result<()> {
    pricing::set_embedded_snapshots(pricing::EmbeddedSnapshots {
        litellm_pricing: ccusage_pricing_snapshots::LITELLM_PRICING,
        models_dev_pricing: ccusage_pricing_snapshots::MODELS_DEV_PRICING,
        models_dev_catalog_rules: ccusage_pricing_snapshots::MODELS_DEV_CATALOG_RULES,
    });

    match cli::parse() {
        Command::All(args) if args.shared.json && args.shared.offline => {
            ccusage_adapter_all::run(args)
        }
        _ => Err(cli_error("The Paseo scanner accepts unified offline JSON reports")),
    }
}
