/* BumbleBeam Puzzle: a graphics card's name for the benchmark table, in one standard form ("NVIDIA RTX 3060 Laptop",
   "AMD Radeon RX 7900 XTX", "Intel Arc A770", "Apple M2 Pro"), made from what the browser tells about the card, never
   from words a visitor types. Shared by /bench (to show the name before it is sent) and the API (which makes it again
   from the same raw text, so the table holds only names this file made).

   BBGpuName.of(raw, ua) -> { name, sure } or null
     raw: the browser's own words for the card: WebGL's renderer ("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU
          (0x00002520) Direct3D11 ...)") or the site's gpuName() ("NVIDIA GeForce RTX 3060 Laptop GPU (nvidia — ampere)")
     ua:  the browser's user agent (Firefox reports a stand-in model on purpose)
     sure: false when the browser hides the exact model (Safari's "Apple GPU", Firefox's "..., or similar", only a
          vendor and a generation), or it is a software renderer: the table marks those
     null: nothing in raw names a graphics card (the API refuses it)
   BBGpuName.cpu(threads) -> { name: 'CPU, 15 threads', sure: true } or null */
(function (root) {
  'use strict';
  function clean(s) {
    return String(s || '').replace(/\((?:R|TM|C)\)|®|™/gi, ' ').replace(/\b(Corporation|Corp\.?|Inc\.?|Technologies|Graphics Card)\b/gi, ' ')
      .replace(/[^\w .,+\-()/—]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cap(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w; }
  function sp(s) { return s.replace(/\s+/g, ' ').trim(); }

  function of(raw, ua) {
    var r = String(raw || '').slice(0, 300), vendor = '', arch = '';
    // the site's gpuName() keeps "(vendor, generation)" (before: "(vendor — generation)") at the end: keep them aside for the fallback
    var tail = /\(([a-z0-9 ._-]*?)(?:\s*(?:—|,)\s+([a-z0-9 ._-]*))?\)\s*$/i.exec(r);
    if (tail && !/0x[0-9a-f]+/i.test(tail[0])) { vendor = (tail[1] || '').trim(); arch = (tail[2] || '').trim(); r = r.slice(0, tail.index); }
    var bare = /^\s*([a-z]+)\s*[·—]\s*([a-z0-9._-]+)\s*$/i.exec(r); // an older form: "nvidia · ampere"
    if (bare) { vendor = bare[1]; arch = bare[2]; r = ''; }
    var unsure = /or similar/i.test(r) || /Firefox\//.test(ua || ''), s = clean(r.replace(/,?\s*or similar/i, '')), m;
    var out = function (name, ok) { return { name: sp(name).slice(0, 48), sure: !!ok && !unsure }; };

    if (/SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render|lavapipe/i.test(raw)) return out('Software renderer', false);
    // NVIDIA: GeForce RTX / GTX / GT / MX, TITAN, Quadro, the RTX A and Ada workstation cards, the data-centre ones
    if ((m = /\b(?:GeForce\s+)?(RTX|GTX|GT|MX)\s*(\d{3,4})(?:\s*(Ti\s+SUPER|Ti|SUPER)\b)?(?:\s+(?:with\s+)?(Laptop|Mobile|Max-?Q))?/i.exec(s))) {
      return out('NVIDIA ' + m[1].toUpperCase() + ' ' + m[2] + (m[3] ? ' ' + m[3].replace(/super/i, 'SUPER').replace(/ti/i, 'Ti') : '') + (m[4] ? ' Laptop' : ''), true);
    }
    if ((m = /\bTITAN\s+(RTX|V|Xp|X|Z|Black)\b/i.exec(s))) return out('NVIDIA TITAN ' + m[1], true);
    if ((m = /\bQuadro\s+([A-Z]{1,3}\d{2,4}\w*)/i.exec(s))) return out('NVIDIA Quadro ' + m[1].toUpperCase(), true);
    if ((m = /\bRTX\s+(A\d{3,4}|\d{4}\s+Ada)(?:\s+(Laptop|Mobile))?/i.exec(s))) return out('NVIDIA RTX ' + m[1] + (m[2] ? ' Laptop' : ''), true);
    if ((m = /\bNVIDIA\s+([AHLT]\d{1,3})\b/i.exec(s))) return out('NVIDIA ' + m[1].toUpperCase(), true);
    // AMD: Radeon RX / R9 / Pro / Vega / the laptop ones; "Radeon Graphics" is a Ryzen's built-in one, model unknown
    if ((m = /\bRadeon\s+(RX\s*\d{3,4}\s*(?:XTX|XT|GRE|M|S)?|R[579]\s*\d{3}X?|Pro\s+[A-Z]?\d{3,4}\w*|Vega\s*\d+|\d{3,4}M)\b/i.exec(s))) {
      return out('AMD Radeon ' + m[1].replace(/^rx\s*/i, 'RX ').replace(/^pro\s+/i, 'Pro ').replace(/^vega\s*/i, 'Vega ').toUpperCase().replace(/^PRO /, 'Pro ').replace(/^VEGA /, 'Vega '), true);
    }
    if (/\bRadeon\b/i.test(s)) return out('AMD Radeon (built in)', false);
    // Intel: Arc, Iris Xe / Plus / Pro, UHD / HD Graphics
    if ((m = /\bArc\s+([AB]\d{3,4}M?)\b/i.exec(s))) return out('Intel Arc ' + m[1].toUpperCase(), true);
    if ((m = /\bIris\s*(Xe|Plus|Pro)(?:\s+MAX)?/i.exec(s))) return out('Intel Iris ' + (m[1].toLowerCase() === 'xe' ? 'Xe' : cap(m[1])), true);
    if ((m = /\b(UHD|HD)\s+Graphics\s*(\d{3,4})?/i.exec(s)) && /Intel/i.test(s + vendor)) return out('Intel ' + m[1].toUpperCase() + ' Graphics' + (m[2] ? ' ' + m[2] : ''), !!m[2]);
    // Apple: the M and A chips; Safari only ever says "Apple GPU"
    if ((m = /\bApple\s+(M\d+)(?:\s+(Pro|Max|Ultra))?\b/i.exec(s))) return out('Apple ' + m[1].toUpperCase() + (m[2] ? ' ' + cap(m[2]) : ''), true);
    if ((m = /\bApple\s+(A\d{2}\w*)\b/i.exec(s))) return out('Apple ' + m[1], true);
    if (/\bApple\b/i.test(s + ' ' + vendor)) return out('Apple GPU', false);
    // phones: Qualcomm Adreno, ARM Mali, PowerVR, Samsung Xclipse
    if ((m = /\bAdreno\D{0,8}(\d{3})/i.exec(s))) return out('Qualcomm Adreno ' + m[1], true);
    if ((m = /\bMali-?\s*([GT]\d{2,3}(?:\s*MP\d+)?)/i.exec(s))) return out('ARM Mali-' + m[1].toUpperCase().replace(/\s+/g, ' '), true);
    if ((m = /\bPowerVR\s+([\w-]+)/i.exec(s))) return out('PowerVR ' + m[1], true);
    if ((m = /\bXclipse\s+(\d{3})/i.exec(s))) return out('Samsung Xclipse ' + m[1], true);
    // only a vendor (and a generation) known: a name, marked unsure
    var v = (/nvidia/i.test(s + vendor) && 'NVIDIA') || (/\bamd\b|\bati\b/i.test(s + ' ' + vendor) && 'AMD') || (/intel/i.test(s + vendor) && 'Intel') || (/qualcomm/i.test(s + vendor) && 'Qualcomm') || (/\barm\b/i.test(s + ' ' + vendor) && 'ARM');
    if (v) return out(v + (arch && /^[a-z0-9 ._-]{2,20}$/i.test(arch) ? ' (' + arch.toLowerCase() + ')' : ' GPU'), false);
    return null;
  }
  function cpu(threads) {
    var n = Math.floor(Number(threads));
    return n >= 1 && n <= 512 ? { name: 'CPU, ' + n + ' threads', sure: true } : null;
  }
  var api = { of: of, cpu: cpu };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BBGpuName = api;
})(this);
