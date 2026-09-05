// Deterministic repo-native icon. No image API, credentials or dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(directory, { recursive: true });
const size = 256;
const background = [20, 34, 46], white = [239, 247, 248], teal = [84, 226, 193];
const shapes = [
  { color: white, width: 13, points: [[86, 78], [45, 128], [86, 178]] },
  { color: white, width: 13, points: [[170, 78], [211, 128], [170, 178]] },
  { color: teal, width: 11, points: [[101, 106], [158, 106], [144, 92]] },
  { color: teal, width: 11, points: [[158, 106], [144, 120]] },
  { color: teal, width: 11, points: [[155, 150], [98, 150], [112, 164]] },
  { color: teal, width: 11, points: [[98, 150], [112, 136]] },
];
function distance(x, y, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const t = Math.max(0, Math.min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-a[0]-t*dx, y-a[1]-t*dy);
}
const rows = Buffer.alloc((size*4+1)*size);
for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
  const color=[0,0,0]; let alpha=0;
  for(let sy=0;sy<4;sy++) for(let sx=0;sx<4;sx++) {
    const px=x+(sx+.5)/4, py=y+(sy+.5)/4;
    if(Math.hypot(Math.max(Math.abs(px-128)-76,0),Math.max(Math.abs(py-128)-76,0))>52) continue;
    let sample=background;
    for(const shape of shapes) if(shape.points.slice(1).some((b,i)=>distance(px,py,shape.points[i],b)<=shape.width/2)) sample=shape.color;
    for(let i=0;i<3;i++) color[i]+=sample[i]; alpha++;
  }
  const offset=y*(size*4+1)+1+x*4;
  for(let i=0;i<3;i++) rows[offset+i]=alpha?Math.round(color[i]/alpha):0;
  rows[offset+3]=Math.round(alpha/16*255);
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:9})),chunk('IEND',Buffer.alloc(0))]);
if(png.length>10240)throw new Error('Icon exceeds 10 KiB.');
writeFileSync(new URL('../assets/autodev-icon.png',import.meta.url),png);
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="52" fill="#14222e"/>${shapes.map(s=>`<polyline points="${s.points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="rgb(${s.color.join(',')})" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>\n`;
writeFileSync(new URL('../assets/autodev-icon.svg',import.meta.url),svg);
console.log(`AutoDev icon: 256 x 256 PNG, ${png.length} bytes.`);
