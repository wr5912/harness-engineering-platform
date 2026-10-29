import { zipSync, strToU8 } from 'fflate'

// 生成真实 PDF 对象和交叉引用表；中文字体使用 PDF.js 本地 CMap 解析。
export function pdfBytes(pages = ['中文知识集'], { encrypted = false, pageCount = pages.length } = {}) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>']
  const kids = []
  for (let i = 0; i < pageCount; i++) {
    const page = objects.length
    const content = page + 1
    kids.push(`${page} 0 R`)
    const text = pages[i % pages.length]
    if (text === null) {
      const image = page + 2
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`)
      const drawing = 'q 100 0 0 100 40 600 cm /Im1 Do Q'
      objects.push(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`)
      objects.push(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n'), Buffer.from([255, 255, 255]), Buffer.from('\nendstream')]))
    } else {
      const encoded = Buffer.from(text, 'utf16le').swap16().toString('hex')
      const drawing = text ? `BT /F1 14 Tf 40 720 Td <${encoded}> Tj ET` : ''
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`)
      objects.push(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`)
    }
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  const encryption = encrypted ? objects.length : undefined
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 /Length 40 >>`)
  const chunks = [Buffer.from('%PDF-1.7\n')]
  const offsets = [0]
  let offset = chunks[0].length
  for (let i = 1; i < objects.length; i++) {
    offsets.push(offset)
    const object = Buffer.concat([Buffer.from(`${i} 0 obj\n`), Buffer.from(objects[i]), Buffer.from('\nendobj\n')])
    chunks.push(object)
    offset += object.length
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R${encryption ? ` /Encrypt ${encryption} 0 R /ID [<${'11'.repeat(16)}> <${'11'.repeat(16)}>]` : ''} >>\nstartxref\n${offset}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

export function docxBytes(paragraphs = ['中文知识集', '业务智能体资料']) {
  const escaped = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${escaped(text)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`),
  })
}
