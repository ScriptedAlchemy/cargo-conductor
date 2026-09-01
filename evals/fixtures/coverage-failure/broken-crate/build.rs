use std::{env, thread, time::Duration};

fn main() {
    println!("cargo:rerun-if-env-changed=CC_EVAL_SLEEP_MS");
    let millis = env::var("CC_EVAL_SLEEP_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    thread::sleep(Duration::from_millis(millis));
}
