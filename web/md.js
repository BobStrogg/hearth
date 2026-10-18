// Tiny, safe markdown renderer: escapes all HTML first, then applies a small subset.
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  window.renderMarkdown = function (src) {
    const out = []; const lines = src.split("\n"); let i = 0; let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
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
      if ((m = /^(#{1,4})\s+(.*)/.exec(e))) { closeList(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); }
      else if ((m = /^\s*[-*]\s+(.*)/.exec(e))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = /^\s*\d+\.\s+(.*)/.exec(e))) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (/^&gt;\s?/.test(e)) { closeList(); out.push(`<blockquote>${inline(e.replace(/^&gt;\s?/, ""))}</blockquote>`); }
      else if (!e.trim()) { closeList(); }
      else { closeList(); out.push(`<p>${inline(e)}</p>`); }
      i++;
    }
    closeList();
    return out.join("");
  };
  window.escapeHtml = esc;
})();
