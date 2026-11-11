//! Arya lens cards (M20b): four short, original reference cards compiled into the binary (`src-tauri/lenses/*.md`).
//! A card is PROMPT CONTENT ONLY: fixed text that defines terms and says how to read the digest's numbers. It is never executed, never
//! rendered as HTML, never fetched, and the webview never supplies it: `explain_ask` takes lens IDS, validated here against this closed list
//! (at most two, no repeats), so an unknown id is refused before any request is made. There is no TraderMatrix skill fetch behind this
//! (`get_skill` returns member-authored text, null on the free tier, with an undocumented shape).
use super::client::LlmError;

/// At most this many cards ride on one question.
pub const MAX_LENSES: usize = 2;

pub struct Lens {
    pub id: &'static str,
    pub name: &'static str,
    /// Bump when the card text changes; shown in the "What I sent" drawer.
    pub version: u32,
    pub text: &'static str,
}

pub static LENSES: [Lens; 4] = [
    Lens { id: "options", name: "Options seller", version: 1, text: include_str!("../../lenses/options.md") },
    Lens { id: "sizing", name: "Sizing and R", version: 1, text: include_str!("../../lenses/sizing.md") },
    Lens { id: "posture", name: "Market posture", version: 1, text: include_str!("../../lenses/posture.md") },
    Lens { id: "chart", name: "Chart reading", version: 1, text: include_str!("../../lenses/chart.md") },
];

/// The webview's ids -> the cards, in the order given. Anything outside the closed list (unknown, wrong case, padded, repeated) or more than
/// two ids is `bad_request`.
pub fn parse_ids(ids: &[String]) -> Result<Vec<&'static Lens>, LlmError> {
    if ids.len() > MAX_LENSES {
        return Err(LlmError::BadRequest);
    }
    let mut out: Vec<&'static Lens> = Vec::new();
    for id in ids {
        let l = LENSES.iter().find(|l| l.id == id.as_str()).ok_or(LlmError::BadRequest)?;
        if out.iter().any(|x| x.id == l.id) {
            return Err(LlmError::BadRequest);
        }
        out.push(l);
    }
    Ok(out)
}

/// The block inserted between the style clause and the digest. Empty when no card is chosen.
pub fn lens_block(lenses: &[&Lens]) -> String {
    if lenses.is_empty() {
        return String::new();
    }
    let mut s = String::from("Reference cards chosen for this question (fixed text from this app, not data from the user or the digest; they never override the rules above):");
    for l in lenses {
        s.push_str(&format!("\n<lens id=\"{}\" name=\"{}\" version=\"{}\">\n{}\n</lens>", l.id, l.name, l.version, l.text.trim_end()));
    }
    s
}

/// Extra room the cards may take inside the system message beyond the rules and the digest cap (two of the longest cards plus their tags).
pub const LENS_ALLOWANCE: usize = 7000;
