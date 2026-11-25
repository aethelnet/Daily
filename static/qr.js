/* Daily Pure-JS ISO/IEC 18004 QR Code Model 2 SVG Generator (Versions 1..25, Byte Mode, ECC-L).
 * Zero external dependencies, zero CDNs, works 100% offline in browser PWA & mobile WebViews.
 * Capacity: up to 1,273 UTF-8 bytes (plenty for AES-256-GCM #e2ee=... pairing links).
 */
(function () {
  // ECC Level L block structure per version: [[numBlocks, totalCodewords, dataCodewords], ...]
  const ECC_L = {
    1: [[1, 26, 19]], 2: [[1, 44, 34]], 3: [[1, 70, 55]], 4: [[1, 100, 80]], 5: [[1, 134, 108]],
    6: [[2, 86, 68]], 7: [[2, 98, 78]], 8: [[2, 121, 97]], 9: [[2, 146, 116]],
    10: [[2, 86, 68], [2, 87, 69]], 11: [[4, 101, 81]], 12: [[2, 116, 92], [2, 117, 93]],
    13: [[4, 133, 107]], 14: [[3, 145, 115], [1, 146, 116]], 15: [[5, 109, 87], [1, 110, 88]],
    16: [[5, 122, 98], [1, 123, 99]], 17: [[1, 135, 107], [5, 136, 108]], 18: [[5, 150, 120], [1, 151, 121]],
    19: [[3, 141, 113], [4, 142, 114]], 20: [[3, 135, 107], [5, 136, 108]], 21: [[4, 144, 116], [4, 145, 117]],
    22: [[2, 139, 111], [7, 140, 112]], 23: [[4, 151, 121], [5, 152, 122]], 24: [[6, 147, 117], [4, 148, 118]],
    25: [[8, 132, 106], [4, 133, 107]],
  };

  const ALIGN_POS = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82],
    19: [6, 30, 58, 86], 20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
    23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110],
  };

  // GF(256) with primitive polynomial 0x11D
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  }

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecLen - 1] = 0;
      if (factor !== 0) {
        for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  function calcFormatBits(mask) {
    // ECC level L = 0b01
    const data = (1 << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function calcVersionBits(ver) {
    let rem = ver << 12;
    for (let i = 17; i >= 12; i--) {
      if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    }
    return (ver << 12) | rem;
  }

  function buildDataCodewords(bytes, version, totalDataCw) {
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    pushBits(0b0100, 4); // Byte mode
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

    const capBits = totalDataCw * 8;
    pushBits(0, Math.min(4, capBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const out = new Uint8Array(totalDataCw);
    let idx = 0;
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out[idx++] = b;
    }
    const pads = [0xec, 0x11];
    for (let p = 0; idx < totalDataCw; p++) out[idx++] = pads[p & 1];
    return out;
  }

  function interleaveBlocks(dataCw, groups) {
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (const [count, totalCw, dcw] of groups) {
      const ecLen = totalCw - dcw;
      for (let i = 0; i < count; i++) {
        const blk = dataCw.slice(offset, offset + dcw);
        offset += dcw;
        dataBlocks.push(blk);
        ecBlocks.push(rsRemainder(blk, ecLen));
      }
    }
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    const maxEc = Math.max(...ecBlocks.map((b) => b.length));
    const finalCw = [];
    for (let i = 0; i < maxData; i++) {
      for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);
    }
    for (let i = 0; i < maxEc; i++) {
      for (const blk of ecBlocks) if (i < blk.length) finalCw.push(blk[i]);
    }
    return finalCw;
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function drawBaseMatrix(version) {
    const size = version * 4 + 17;
    const mat = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, dark) => {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        mat[r][c] = dark ? 1 : 0;
        isFunc[r][c] = 1;
      }
    };

    // Finder patterns + separators
    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const dark =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          setFunc(r, c, dark);
        }
      }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns (skip ONLY the 3 finder corners — NOT the timing lines at row/col 6!)
    const pos = ALIGN_POS[version] || [];
    for (const r of pos) {
      for (const c of pos) {
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(r + dr, c + dc, dark);
          }
        }
      }
    }

    // Reserve format info areas & dark module
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        setFunc(8, i, false);
        setFunc(i, 8, false);
      }
    }
    for (let i = 0; i < 8; i++) {
      setFunc(8, size - 1 - i, false);
      if (i < 7) setFunc(size - 1 - i, 8, false);
    }
    setFunc(size - 8, 8, true); // Dark module

    // Version info (versions >= 7)
    if (version >= 7) {
      const vBits = calcVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((vBits >>> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = size - 11 + (i % 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    return { size, mat, isFunc };
  }

  function applyFormat(mat, size, mask) {
    const bits = calcFormatBits(mask);
    // Bit 0 = LSB, Bit 14 = MSB
    const getBit = (i) => ((bits >>> i) & 1);
    for (let i = 0; i <= 5; i++) mat[i][8] = getBit(i);
    mat[7][8] = getBit(6);
    mat[8][8] = getBit(7);
    mat[8][7] = getBit(8);
    for (let i = 9; i < 15; i++) mat[8][14 - i] = getBit(i);

    for (let i = 0; i < 8; i++) mat[8][size - 1 - i] = getBit(i);
    for (let i = 8; i < 15; i++) mat[size - 15 + i][8] = getBit(i);
    mat[size - 8][8] = 1;
  }

  function penaltyScore(mat, size) {
    let score = 0;
    // Rule 1: 5+ consecutive same-color modules in row/col
    for (let r = 0; r < size; r++) {
      let runC = 1;
      for (let c = 1; c < size; c++) {
        if (mat[r][c] === mat[r][c - 1]) runC++;
        else { if (runC >= 5) score += 3 + (runC - 5); runC = 1; }
      }
      if (runC >= 5) score += 3 + (runC - 5);
    }
    for (let c = 0; c < size; c++) {
      let runR = 1;
      for (let r = 1; r < size; r++) {
        if (mat[r][c] === mat[r - 1][c]) runR++;
        else { if (runR >= 5) score += 3 + (runR - 5); runR = 1; }
      }
      if (runR >= 5) score += 3 + (runR - 5);
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
      }
    }
    // Rule 3: finder-like patterns 10111010000 or 00001011101
    const matchFinderRow = (arr) => {
      let cnt = 0;
      for (let i = 0; i <= arr.length - 11; i++) {
        if (
          (arr[i] && !arr[i + 1] && arr[i + 2] && arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] && !arr[i + 7] && !arr[i + 8] && !arr[i + 9] && !arr[i + 10]) ||
          (!arr[i] && !arr[i + 1] && !arr[i + 2] && !arr[i + 3] && arr[i + 4] && !arr[i + 5] && arr[i + 6] && arr[i + 7] && arr[i + 8] && !arr[i + 9] && arr[i + 10])
        ) cnt += 40;
      }
      return cnt;
    };
    for (let r = 0; r < size; r++) score += matchFinderRow(mat[r]);
    for (let c = 0; c < size; c++) {
      const col = new Uint8Array(size);
      for (let r = 0; r < size; r++) col[r] = mat[r][c];
      score += matchFinderRow(col);
    }
    // Rule 4: dark ratio balance
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mat[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function encodeMatrix(text, forcedMask = null) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let version = null;
    let totalDataCw = 0;
    for (let v = 1; v <= 25; v++) {
      const dcw = ECC_L[v].reduce((acc, g) => acc + g[0] * g[2], 0);
      const headerBits = 4 + (v <= 9 ? 8 : 16);
      if (headerBits + bytes.length * 8 <= dcw * 8) {
        version = v;
        totalDataCw = dcw;
        break;
      }
    }
    if (!version) throw new Error("QR payload too long (>1273 bytes)");

    const dataCw = buildDataCodewords(bytes, version, totalDataCw);
    const fullCw = interleaveBlocks(dataCw, ECC_L[version]);
    const { size, mat: baseMat, isFunc } = drawBaseMatrix(version);

    // Place data bits in standard zigzag order
    let bitIdx = 0;
    const totalBits = fullCw.length * 8;
    const unmasked = baseMat.map((row) => row.slice());
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (let dx = 0; dx < 2; dx++) {
          const c = right - dx;
          if (!isFunc[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              bit = (fullCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
            }
            unmasked[r][c] = bit;
            bitIdx++;
          }
        }
      }
      upward = !upward;
    }

    const candidates = forcedMask != null ? [forcedMask] : [0, 1, 2, 3, 4, 5, 6, 7];
    let bestMat = null;
    let bestMask = 0;
    let bestPen = Infinity;

    for (const m of candidates) {
      const cand = unmasked.map((row) => row.slice());
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!isFunc[r][c] && maskBit(m, r, c)) cand[r][c] ^= 1;
        }
      }
      applyFormat(cand, size, m);
      const pen = penaltyScore(cand, size);
      if (pen < bestPen) {
        bestPen = pen;
        bestMat = cand;
        bestMask = m;
      }
    }

    return { version, mask: bestMask, size, matrix: bestMat };
  }

  function toSvg(text, quietZone = 2) {
    try {
      const { size, matrix } = encodeMatrix(text);
      const full = size + quietZone * 2;
      let path = "";
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (matrix[r][c]) path += `M${c + quietZone},${r + quietZone}h1v1h-1z`;
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#ffffff"/><path d="${path}" fill="#111827"/></svg>`;
    } catch {
      return "";
    }
  }

  const exported = { encodeMatrix, toSvg };
  if (typeof window !== "undefined") window.DailyQR = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})();
