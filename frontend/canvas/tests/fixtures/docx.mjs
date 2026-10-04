// Locally generated DOCX container; no external document, service or fixture dependency.
import {deflateRawSync} from 'node:zlib';
const crc32 = bytes => {
 let c=0xffffffff;
 for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
 return (c^0xffffffff)>>>0;
};
export function docxFixture(xml,{descriptor=true,method=8,entries:extra=[]}={}){
 const types='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
 const files=[['[Content_Types].xml',types],['word/document.xml',xml],...extra];
 const parts=[],directory=[];let offset=0;
 for(const [path,text] of files){
  const name=Buffer.from(path),plain=Buffer.from(text),data=method===8?deflateRawSync(plain):plain,crc=crc32(plain),flag=descriptor?8:0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flag,6);local.writeUInt16LE(method,8);local.writeUInt16LE(name.length,26);
  if(!descriptor){local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(plain.length,22);}
  const dd=Buffer.alloc(descriptor?16:0);if(descriptor){dd.writeUInt32LE(0x08074b50);dd.writeUInt32LE(crc,4);dd.writeUInt32LE(data.length,8);dd.writeUInt32LE(plain.length,12);}
  const cen=Buffer.alloc(46);cen.writeUInt32LE(0x02014b50);cen.writeUInt16LE(20,4);cen.writeUInt16LE(20,6);cen.writeUInt16LE(flag,8);cen.writeUInt16LE(method,10);cen.writeUInt32LE(crc,16);cen.writeUInt32LE(data.length,20);cen.writeUInt32LE(plain.length,24);cen.writeUInt16LE(name.length,28);cen.writeUInt32LE(offset,42);
  parts.push(local,name,data,dd);directory.push(cen,name);offset+=local.length+name.length+data.length+dd.length;
 }
 const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,central,end]);
}
export const SCRIPT_XML='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>序幕：夜色中的城市</w:t></w:r></w:p><w:p><w:r><w:t>第1镜 雨夜，5秒</w:t><w:br/><w:t>主角回头，街灯倒影。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>第2镜 重逢，8秒</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>两人相视，镜头缓缓拉远。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
