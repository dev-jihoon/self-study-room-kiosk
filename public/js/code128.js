/* Code 128 (B 세트) 바코드를 SVG로 그린다. 외부 라이브러리 없이 시연용 카드에 쓴다. */
(function () {
  'use strict';
  const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
    + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
    + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
    + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
    + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
    + '114131 311141 411131 211412 211214 211232 2331112').split(' ');

  /* 문자열을 막대 너비 목록으로 */
  function widths(text) {
    const codes = [104];
    for (const ch of String(text)) {
      const v = ch.charCodeAt(0) - 32;
      if (v < 0 || v > 94) throw new Error('Code 128 B로 쓸 수 없는 문자: ' + ch);
      codes.push(v);
    }
    let sum = codes[0];
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, 106);
    return codes.map((c) => P[c]).join('');
  }

  /* svg 요소를 채운다. quiet: 양옆 여백(모듈 수) */
  function draw(svg, text, opts) {
    opts = opts || {};
    const quiet = opts.quiet == null ? 10 : opts.quiet;
    const w = widths(text);
    let x = quiet, rects = '';
    for (let i = 0; i < w.length; i++) {
      const n = Number(w[i]);
      if (i % 2 === 0) rects += '<rect x="' + x + '" y="0" width="' + n + '" height="100"/>';
      x += n;
    }
    const total = x + quiet;
    svg.setAttribute('viewBox', '0 0 ' + total + ' 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = '<rect x="0" y="0" width="' + total + '" height="100" fill="#fff"/><g fill="#000">' + rects + '</g>';
    return svg;
  }

  window.Code128 = { widths, draw };
})();
