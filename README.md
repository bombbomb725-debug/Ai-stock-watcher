# AI Stock Watcher

แดชบอร์ด PWA ภาษาไทยสำหรับติดตาม **ASTS, RKLB, IONQ และ OKLO** พร้อม EMA20/EMA50, RSI14 และ MACD

## ไฟล์ในโครงการ
- `index.html`, `styles.css`, `app.js`: หน้า Dashboard
- `manifest.webmanifest`, `sw.js`, `icon.svg`: ส่วน PWA และ Service Worker
- `worker.js`, `wrangler.toml`: API proxy สำหรับ Cloudflare Workers

## ขั้นตอนติดตั้ง (เน้น Free tier)

### 1. ตั้งค่าแหล่งข้อมูล Alpaca
สมัครบัญชี Alpaca และสร้าง API Key/Secret สำหรับ Market Data จากนั้นเลือกใช้ IEX feed ตามที่โค้ดกำหนดไว้

> IEX เป็นเพียงหนึ่ง venue/feed ไม่ใช่ consolidated SIP feed และข้อมูล/สิทธิ์การเข้าถึงขึ้นกับบัญชี Alpaca ห้ามนำ API key ไปใส่ใน `app.js` หรือไฟล์หน้าเว็บเด็ดขาด

### 2. Deploy API บน Cloudflare Workers
ติดตั้ง Wrangler และล็อกอิน Cloudflare จากเครื่องคอมพิวเตอร์:
```bash
npm install -g wrangler
wrangler login
wrangler secret put ALPACA_KEY
wrangler secret put ALPACA_SECRET
wrangler deploy
``

ตั้งค่า secret ตาม prompt ให้ครบทั้งสองตัว ค่า `ALLOWED_ORIGIN` ใน `wrangler.toml` ตั้งต้นเป็น origin ของ GitHub Pages:
`https://bombbomb725-debug.github.io`
หากใช้โดเมนอื่น ให้แก้ค่าเป็น origin นั้นก่อน deploy (ไม่ต้องใส่ path ต่อท้าย)

### 3. เปิด GitHub Pages
ไปที่ repository Settings → Pages → Build and deployment เลือก Deploy from a branch, branch `main`, folder `/ (root)` แล้ว Save

เมื่อ Pages พร้อมใช้งาน URL โดยทั่วไปคือ:
`https://bombbomb725-debug.github.io/Ai-stock-watcher/`

### 4. เชื่อม Worker กับ Dashboard
เปิดเว็บไซต์ กรอก URL ที่ Wrangler แสดงหลัง deploy (เช่น `https://ai-stock-watcher-api.<บัญชี>.workers.dev`) ในช่อง Worker API URL แล้วกดบันทึก

## วิธีคำนวณสัญญาณ
- EMA20/EMA50: ค่าเฉลี่ยเคลื่อนที่แบบ exponential จากแท่งรายวัน
- RSI14: คำนวณจากการเปลี่ยนแปลงของราคาปิด 14 ช่วงล่าสุด
- MACD: EMA12 ลบ EMA26 (แสดงค่า MACD line; ยังไม่ได้คำนวณ signal line/histogram)
- สัญญาณเป็นตัวกรองเชิงเทคนิคอย่างง่าย ไม่ใช่คำแนะนำให้ซื้อหรือขาย

## ข้อจำกัดและความปลอดภัย
- ราคาและแท่งข้อมูลมาจาก Alpaca IEX feed; ไม่รับประกันว่าเป็นราคาตลาดรวมทุก venue หรือ real-time แบบ SIP
- Dashboard แสดง timestamp ของ trade ล่าสุดและเวลาที่ API ดึงข้อมูล
- หากไม่มี trade หรือ bars จะเห็นข้อมูลไม่ครบ ไม่ควรตีความว่าเป็นราคา 0
- ยังไม่มีระบบส่ง Push notification จริง แม้ Service Worker จะรองรับการรับ push event แล้วก็ตาม ต้องเพิ่ม VAPID key, endpoint เก็บ subscription และ scheduler/ระบบส่งแจ้งเตือนก่อน
- ห้าม commit API keys, secrets หรือ private keys ลง GitHub
- ตรวจสอบข้อมูลกับโบรกเกอร์ก่อนตัดสินใจลงทุน

## สถานะ
ซอร์ส Dashboard และ Worker proxy ถูกเพิ่มใน repository แล้ว แต่ยังต้อง deploy Worker, ตั้งค่า secrets และเปิด GitHub Pages ก่อนจึงจะใช้งานออนไลน์ได้
