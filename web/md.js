// Tiny, safe markdown renderer: escapes all HTML first, then applies a small subset.
// Images: renderMarkdown(src, { img(url) -> safe src | null }) turns ![alt](url) (and links to image files) into <img>.
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[n]));
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i;
  const imgTag = (src, alt) => `<img class="inl" src="${esc(src)}" alt="${alt}" loading="lazy" decoding="async">`;
  function inline(s, opts) {
    const keep = []; const put = (html) => `\u0001${keep.push(html) - 1}\u0001`;
    const resolve = (u) => (opts && opts.img ? opts.img(unesc(u)) : null);
    s = s
      .replace(/`([^`]+)`/g, (_, c) => put(`<code>${c}</code>`))
      // ![alt](url "title")
      .replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;[^]*?&quot;)?\s*\)/g, (m, alt, u) => { const src = resolve(u); return src ? put(imgTag(src, alt)) : m; })
      // [text](url): http(s) links; links to image files also show the image
      .replace(/\[([^\]]+)\]\(\s*([^\s)]+)\s*\)/g, (m, text, u) => {
        const isHttp = /^https?:\/\//i.test(unesc(u));
        const src = IMG_EXT.test(unesc(u)) || /^data:image\//i.test(unesc(u)) ? resolve(u) : null;
        if (!isHttp && !src) return m;
        const a = isHttp ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
        return put(src ? `${a}<br>${imgTag(src, text)}` : a);
      });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    for (let n = 0; n < 4 && s.includes("\u0001"); n++) s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[+i]);
    return s;
  }
  window.renderMarkdown = function (src, opts) {
    const out = []; const lines = src.replace(/\u0001/g, "").split("\n"); let i = 0; let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const il = (x) => inline(x, opts);
    while (i < lines.length) {
      const l = lines[i];
      const fence = /^```(\S*)/.exec(l);
      if (fence) {
        closeList(); const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
      }
      const e = esc(l);
      let m;
      if ((m = /^(#{1,4})\s+(.*)/.exec(e))) { closeList(); out.push(`<h${m[1].length + 2}>${il(m[2])}</h${m[1].length + 2}>`); }
      else if ((m = /^\s*[-*]\s+(.*)/.exec(e))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${il(m[1])}</li>`); }
      else if ((m = /^\s*\d+\.\s+(.*)/.exec(e))) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${il(m[1])}</li>`); }
      else if (/^&gt;\s?/.test(e)) { closeList(); out.push(`<blockquote>${il(e.replace(/^&gt;\s?/, ""))}</blockquote>`); }
      else if (!e.trim()) { closeList(); }
      else { closeList(); out.push(`<p>${il(e)}</p>`); }
      i++;
    }
    closeList();
    return out.join("");
  };
  window.escapeHtml = esc;
})();
