'use strict';
/**
 * A tiny reportlab.pdfgen.canvas look-alike on top of pdfkit, so the PDF
 * code ports line-for-line: points, origin at the bottom-left, text drawn
 * on its baseline, showPage()/save() semantics.
 */
const PDFDocument = require('pdfkit');

const mm = 72 / 25.4;
const A4 = [595.2755905511812, 841.8897637795277];
const landscape = (size) => [Math.max(...size), Math.min(...size)];

class Canvas {
  constructor({ pagesize = A4 } = {}) {
    this.width = pagesize[0];
    this.height = pagesize[1];
    this.doc = new PDFDocument({ size: [this.width, this.height], margin: 0, autoFirstPage: false });
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
    this.pageOpen = false;
    this.pages = 0;
    this.fontName = 'Helvetica';
    this.fontSize = 12;
  }

  _ensurePage() {
    if (!this.pageOpen) {
      this.doc.addPage({ size: [this.width, this.height], margin: 0 });
      this.pageOpen = true;
      this.pages++;
      this.doc.font(this.fontName).fontSize(this.fontSize);
    }
  }

  setFont(name, size) {
    this.fontName = name;
    this.fontSize = size;
    if (this.pageOpen) this.doc.font(name).fontSize(size);
  }

  setFillColor(color) { this._ensurePage(); this.doc.fillColor(color); }
  setStrokeColor(color) { this._ensurePage(); this.doc.strokeColor(color); }

  drawString(x, y, text) {
    this._ensurePage();
    this.doc.text(String(text), x, this.height - y, { lineBreak: false, baseline: 'alphabetic' });
  }

  drawRightString(x, y, text) {
    this._ensurePage();
    const s = String(text);
    const w = this.doc.widthOfString(s);
    this.doc.text(s, x - w, this.height - y, { lineBreak: false, baseline: 'alphabetic' });
  }

  drawCentredString(x, y, text) {
    this._ensurePage();
    const s = String(text);
    const w = this.doc.widthOfString(s);
    this.doc.text(s, x - w / 2, this.height - y, { lineBreak: false, baseline: 'alphabetic' });
  }

  line(x1, y1, x2, y2) {
    this._ensurePage();
    this.doc.moveTo(x1, this.height - y1).lineTo(x2, this.height - y2).lineWidth(1).stroke();
  }

  showPage() {
    // Ending a page; the next draw call starts a fresh one.
    if (!this.pageOpen) this._ensurePage();
    this.pageOpen = false;
  }

  /** Finish the document and resolve with the PDF bytes. */
  save() {
    if (this.pages === 0) this._ensurePage();
    return new Promise((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

module.exports = { Canvas, mm, A4, landscape };
