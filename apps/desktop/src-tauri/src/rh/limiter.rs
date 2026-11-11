use std::sync::Mutex;

use tokio::time::{sleep, Duration, Instant};

/// Token bucket shared by every Robinhood call in the app.
pub struct Limiter {
    per_sec: f64,
    burst: f64,
    state: Mutex<(f64, Instant)>,
}

impl Limiter {
    pub fn new(per_sec: u32, burst: u32) -> Self {
        let burst = burst.max(1) as f64;
        Self { per_sec: per_sec.max(1) as f64, burst, state: Mutex::new((burst, Instant::now())) }
    }

    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut g = match self.state.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                let now = Instant::now();
                let elapsed = now.saturating_duration_since(g.1).as_secs_f64();
                g.0 = (g.0 + elapsed * self.per_sec).min(self.burst);
                g.1 = now;
                if g.0 >= 1.0 {
                    g.0 -= 1.0;
                    return;
                }
                Duration::from_secs_f64((1.0 - g.0) / self.per_sec)
            };
            sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn ten_acquires_at_4_per_sec_burst_4_take_at_least_1_4s() {
        let l = Limiter::new(4, 4);
        let t0 = Instant::now();
        for _ in 0..10 {
            l.acquire().await;
        }
        let el = t0.elapsed();
        assert!(el >= Duration::from_millis(1400), "{el:?}");
        assert!(el < Duration::from_millis(2000), "{el:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn burst_is_immediate() {
        let l = Limiter::new(4, 4);
        let t0 = Instant::now();
        for _ in 0..4 {
            l.acquire().await;
        }
        assert_eq!(t0.elapsed(), Duration::ZERO);
    }
}
