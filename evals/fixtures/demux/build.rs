use std::{env, thread, time::Duration};

fn main() {
    let variable = match env::var("CARGO_PKG_NAME").as_deref() {
        Ok("fast-a") => "CC_EVAL_FAST_SLEEP_MS",
        Ok("slow-b") => "CC_EVAL_SLOW_SLEEP_MS",
        _ => return,
    };
    println!("cargo:rerun-if-env-changed={variable}");
    let millis = env::var(variable)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    thread::sleep(Duration::from_millis(millis));
}
