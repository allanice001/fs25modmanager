//! Reads FS25 `modDesc.xml` out of a mod's `.zip` archive to extract display
//! metadata and detect whether the archive is a map.

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Default)]
pub struct ModDesc {
    pub title: String,
    pub author: String,
    pub version: String,
    pub is_map: bool,
}

/// Open `zip_path`, locate `modDesc.xml` and parse the useful bits.
pub fn parse(zip_path: &Path) -> Result<ModDesc, String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut bytes: Vec<u8> = Vec::new();
    let mut found = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // modDesc.xml lives at the archive root; match case-insensitively.
        if entry.name().eq_ignore_ascii_case("modDesc.xml") {
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            found = true;
            break;
        }
    }
    if !found {
        return Err("no modDesc.xml in archive".into());
    }

    // modDesc files are sometimes latin-1; decode lossily so parsing never dies
    // on a stray byte.
    let xml = String::from_utf8_lossy(&bytes);
    parse_xml(&xml)
}

fn parse_xml(raw: &str) -> Result<ModDesc, String> {
    // roxmltree operates on an already-decoded &str, so a `<?xml encoding=...?>`
    // prolog that disagrees with our lossy UTF-8 decode would make it error.
    // Drop the prolog before parsing.
    let xml = match (raw.find("<?xml"), raw.find("?>")) {
        (Some(0), Some(end)) => &raw[end + 2..],
        _ => raw,
    };

    let doc = roxmltree::Document::parse(xml).map_err(|e| e.to_string())?;
    let root = doc.root_element();

    let title = root
        .children()
        .find(|n| n.has_tag_name("title"))
        .map(|t| {
            // <title><en>Name</en><de>...</de></title> — prefer English, else
            // the first language child, else any direct text.
            let en = t
                .children()
                .find(|n| n.has_tag_name("en"))
                .and_then(|n| n.text())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(en) = en {
                return en.to_string();
            }
            let first_lang = t
                .children()
                .find(|n| n.is_element())
                .and_then(|n| n.text())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            first_lang
                .map(|s| s.to_string())
                .unwrap_or_else(|| t.text().unwrap_or("").trim().to_string())
        })
        .unwrap_or_default();

    let text_of = |tag: &str| {
        root.children()
            .find(|n| n.has_tag_name(tag))
            .and_then(|n| n.text())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    // A map mod declares one or more <maps><map .../></maps> entries.
    let is_map = root
        .children()
        .find(|n| n.has_tag_name("maps"))
        .map(|m| m.children().any(|c| c.has_tag_name("map")))
        .unwrap_or(false);

    Ok(ModDesc {
        title,
        author: text_of("author"),
        version: text_of("version"),
        is_map,
    })
}
