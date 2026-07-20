const crypto = require('crypto');

// ========== 配置区，自行修改 ==========
const CONFIG = {
  webhookSecret: "你的闲管家密钥",
};
// ======================================

// 内存存储订单（重启丢失，长期使用建议搭配数据库）
let orderList = [];

// 签名校验
function verifySign(body, sign) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', CONFIG.webhookSecret);
  hmac.update(bodyStr);
  return hmac.digest('hex') === sign;
}

// 字段别名映射
const fieldAlias = {
  orderNo: ["order_no", "orderId", "order_id", "订单号", "tid"],
  orderTime: ["order_time", "createTime", "create_time", "下单时间", "pay_time"],
  logisticsNo: ["logistics_no", "expressNo", "express_no", "物流单号", "waybill_no"],
  phone: ["phone", "receiverPhone", "receiver_phone", "收货手机号", "buyer_phone"],
  amount: ["amount", "payAmount", "pay_amount", "订单金额", "total_fee", "payment"],
  refundAmount: ["refundAmount", "refund_amount", "退款金额", "refund_fee"],
  status: ["status", "orderStatus", "order_status", "订单状态", "status_str"],
  province: ["province", "receiverProvince", "省"],
  city: ["city", "receiverCity", "市"],
  district: ["district", "receiverDistrict", "区"],
  address: ["address", "receiverAddress", "收货地址", "detail_address"]
};

// 订单状态映射
const statusMap = {
  11: { code: 11, text: "待付款", class: "status-pay" },
  12: { code: 12, text: "待发货", class: "status-send" },
  21: { code: 21, text: "待收货", class: "status-receive" },
  22: { code: 22, text: "已完成｜正常完结", class: "status-finish" },
  23: { code: 23, text: "退款中", class: "status-refund" },
  24: { code: 24, text: "已退款（全额）", class: "status-refund" },
  25: { code: 25, text: "已退款（部分）", class: "status-refund" },
  30: { code: 30, text: "已关闭(取消/超时)", class: "status-close" },
  "待付款": { code: 11, text: "待付款", class: "status-pay" },
  "待发货": { code: 12, text: "待发货", class: "status-send" },
  "待收货": { code: 21, text: "待收货", class: "status-receive" },
  "交易成功": { code: 22, text: "已完成｜正常完结", class: "status-finish" },
  "正常完结": { code: 22, text: "已完成｜正常完结", class: "status-finish" },
  "退款中": { code: 23, text: "退款中", class: "status-refund" },
  "退款成功": { code: 24, text: "已退款（全额）", class: "status-refund" },
  "全额退款": { code: 24, text: "已退款（全额）", class: "status-refund" },
  "部分退款": { code: 25, text: "已退款（部分）", class: "status-refund" },
  "交易关闭": { code: 30, text: "已关闭(取消/超时)", class: "status-close" },
  "已关闭": { code: 30, text: "已关闭(取消/超时)", class: "status-close" }
};

// 读取兼容字段
function getField(raw, targetField) {
  const aliases = fieldAlias[targetField] || [targetField];
  for (let key of aliases) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return "";
}

// 时间格式化
function formatTime(timestamp) {
  if (!timestamp) return "-";
  const d = new Date(Number(timestamp) * 1000 || Number(timestamp));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// 格式化单条订单
function calibrateOrder(raw) {
  if (!raw) return null;
  const orderNo = getField(raw, "orderNo");
  if (!orderNo) return null;
  const rawStatus = getField(raw, "status");
  const statusInfo = statusMap[rawStatus] || statusMap[30];
  const amount = Math.max(0, Number(getField(raw, "amount") || 0));
  const refundAmount = Math.max(0, Math.min(amount, Number(getField(raw, "refundAmount") || 0)));
  const actualAmount = Math.max(0, Number((amount - refundAmount).toFixed(2)));
  const province = getField(raw, "province");
  const city = getField(raw, "city");
  const district = getField(raw, "district");
  const address = getField(raw, "address");
  const fullAddress = `${province || ""}${city || ""}${district || ""}${address || ""}`.trim();
  const rawTime = getField(raw, "orderTime");
  const orderTimeStr = formatTime(rawTime);
  const orderTimeDay = orderTimeStr.split(" ")[0];
  return {
    orderNo,
    orderTime: orderTimeStr,
    orderTimeDay,
    logisticsNo: getField(raw, "logisticsNo") || "",
    phone: getField(raw, "phone") || "",
    originalAmount: amount,
    refundAmount,
    actualAmount,
    fullAddress,
    status: statusInfo.code,
    statusText: statusInfo.text,
    statusClass: statusInfo.class,
    searchText: `${orderNo} ${getField(raw, "logisticsNo") || ""} ${getField(raw, "phone") || ""} ${fullAddress} ${statusInfo.text}`
  };
}

// Vercel 入口
module.exports = async (req, res) => {
  const { url, method, headers, body } = req;

  // 1. 闲管家推送接口 POST /webhook
  if (method === "POST" && url === "/webhook") {
    try {
      const sign = headers["x-sign"] || headers.sign || "";
      // 校验签名
      if (CONFIG.webhookSecret && CONFIG.webhookSecret !== "") {
        if (!verifySign(body, sign)) {
          return res.status(403).json({ success: false, msg: "签名校验失败" });
        }
      }
      const dataList = Array.isArray(body) ? body : [body];
      const calibrated = dataList.map(calibrateOrder).filter(Boolean);
      // 内存更新订单
      calibrated.forEach(item => {
        const idx = orderList.findIndex(i => i.orderNo === item.orderNo);
        if (idx > -1) orderList[idx] = item;
        else orderList.unshift(item);
      });
      return res.json({ success: true, count: calibrated.length });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, msg: "服务异常" });
    }
  }

  // 2. 前端拉取订单 GET /api/orders
  if (method === "GET" && url === "/api/orders") {
    return res.json(orderList);
  }

  // 3. 首页页面 GET /
  if (method === "GET" && url === "/") {
    const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: "Microsoft YaHei", sans-serif;
        }
        body {
            background: #fff0f6;
            background-image: radial-gradient(#ffd6e4 8%, transparent 8%);
            background-size: 30px 30px;
            padding: 20px;
        }
        .kitty-card {
            background: #ffffff;
            border-radius: 30px;
            padding: 24px;
            box-shadow: 0 4px 16px #ffc8dd;
            border: 2px solid #ffb6c1;
            margin-bottom: 20px;
        }
        .title-box {
            text-align: center;
            margin-bottom: 20px;
        }
        .title-box h1 {
            color: #ff69b4;
            font-size: 28px;
            letter-spacing: 2px;
        }
        .title-box p {
            color: #ff8fb3;
            margin-top: 6px;
        }
        .sync-tip {
            text-align: center;
            color: #ff5588;
            margin-bottom: 12px;
        }
        .search-area {
            margin-bottom: 16px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: center;
        }
        #globalSearch {
            flex: 1;
            min-width: 260px;
        }
        input[type="text"],
        input[type="date"] {
            border: 1px solid #ffb6c1;
            border-radius: 20px;
            padding: 8px 12px;
            color: #ff5588;
            font-size: 14px;
        }
        button {
            background: #ff8fb3;
            border: none;
            color: white;
            border-radius: 20px;
            padding: 8px 18px;
            cursor: pointer;
            white-space: nowrap;
        }
        button:hover {
            background: #ff69b4;
        }
        .stat-row {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            max-width: 400px;
            margin: 0 auto 20px;
        }
        .finish-stat-row {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            max-width: 400px;
            margin: 0 auto 20px;
        }
        .stat-item {
            background: #ffe6ef;
            border-radius: 24px;
            text-align: center;
            padding: 16px;
            border: 1px solid #ffb6c1;
        }
        .stat-item.finish-stat {
            background: #e6fff4;
            border-color: #00b875;
        }
        .stat-item h3 {
            color: #ff4788;
            font-size: 26px;
        }
        .stat-item.finish-stat h3 {
            color: #009955;
        }
        .stat-item span {
            color: #ff7799;
            font-size: 14px;
        }
        .stat-item.finish-stat span {
            color: #009955;
        }
        .status-bar {
            background: #ffe6ef;
            border-radius: 24px;
            border: 1px solid #ffb6c1;
            padding: 14px 20px;
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            justify-content: center;
            margin-bottom: 20px;
        }
        .status-item {
            font-size: 15px;
            color: #444;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 10px;
            transition: background 0.2s;
        }
        .status-item:hover {
            background: #ffd6e4;
        }
        .status-item.active {
            background: #ffb6c1;
            color: white;
        }
        .status-num {
            font-weight: bold;
            color: #ff4788;
            font-size: 17px;
            margin-left: 6px;
        }
        .status-item.active .status-num {
            color: white;
        }
        .clear-status-btn {
            margin-left: 10px;
            background: #ff6677;
            font-size: 13px;
            padding: 4px 10px;
            border-radius: 12px;
        }
        .chart-row {
            margin-bottom: 20px;
        }
        .chart-box {
            height: 320px;
        }
        .table-wrapper {
            overflow-x: auto;
            border-radius: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 950px;
        }
        thead tr {
            background: #ffb6c1;
        }
        th {
            color: #fff;
            padding: 12px 8px;
            font-size: 14px;
            font-weight: normal;
            white-space: nowrap;
            text-align: left;
        }
        td {
            padding: 12px 8px;
            border-bottom: 1px solid #ffe0ec;
            font-size: 13px;
            word-break: break-all;
        }
        tbody tr:nth-child(even) {
            background: #fff5f9;
        }
        .status-tag {
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
        }
        .status-finish {
            color: #009955;
            background: #e6fff4;
        }
        .status-pay {
            color: #ff9100;
            background: #fff2e0;
        }
        .status-send {
            color: #0099ff;
            background: #e6f3ff;
        }
        .status-receive {
            color: #00b875;
            background: #e6fff4;
        }
        .status-refund {
            color: #ff3366;
            background: #ffe6ef;
        }
        .status-close {
            color: #666;
            background: #eeeeee;
        }
        .refund-mark {
            color: #ff3366;
            font-size: 12px;
            margin-left: 4px;
        }
        .empty-tip {
            text-align: center;
            padding: 40px;
            color: #999;
            font-size: 15px;
        }
        @media (max-width: 1024px) {
            .chart-box {
                height: 280px;
            }
        }
        @media (max-width: 768px) {
            body {
                padding: 10px;
            }
            .kitty-card {
                padding: 16px;
                border-radius: 20px;
            }
            .title-box h1 {
                font-size: 22px;
                letter-spacing: 1px;
            }
            .search-area {
                flex-direction: column;
                align-items: stretch;
            }
            #globalSearch {
                min-width: 100%;
            }
            .stat-row, .finish-stat-row {
                gap: 10px;
            }
            .stat-item {
                padding: 12px;
                border-radius: 18px;
            }
            .stat-item h3 {
                font-size: 20px;
            }
            .stat-item span {
                font-size: 12px;
            }
            .chart-box {
                height: 240px;
            }
            th, td {
                padding: 8px 6px;
                font-size: 12px;
            }
            .status-bar {
                gap: 8px;
                padding: 12px;
            }
            .status-item {
                font-size: 13px;
            }
            .status-num {
                font-size: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="kitty-card">
        <div class="title-box">
            <h1>闲鱼订单监控后台</h1>
            <p>闲管家API推送适配版</p>
        </div>
        <div class="sync-tip" id="syncTip">● 等待闲管家推送数据...</div>
        <div class="search-area">
            <input type="text" id="globalSearch" placeholder="搜索：订单号/物流号/手机号/地址/状态">
            <input type="date" id="startDate">
            <input type="date" id="endDate">
            <button onclick="resetFilter()">重置全部筛选</button>
            <button onclick="manualSync()">加载测试数据</button>
        </div>
        <div class="stat-row">
            <div class="stat-item">
                <h3 id="totalCount">0</h3>
                <span id="countLabel">订单总数</span>
            </div>
            <div class="stat-item">
                <h3 id="pendingAmount">0.00</h3>
                <span>预估到手金额</span>
            </div>
        </div>
        <div class="finish-stat-row">
            <div class="stat-item finish-stat">
                <h3 id="finishCount">0</h3>
                <span>已完结订单总数</span>
            </div>
            <div class="stat-item finish-stat">
                <h3 id="finishAmount">0.00</h3>
                <span>已完结总收入</span>
            </div>
        </div>
        <div class="status-bar">
            <div class="status-item" data-code="22" onclick="filterByStatus(22)">
                正常完结：<span class="status-num" id="numFinish">0</span>
            </div>
            <div class="status-item" data-code="11" onclick="filterByStatus(11)">
                待付款：<span class="status-num" id="numPay">0</span>
            </div>
            <div class="status-item" data-code="12" onclick="filterByStatus(12)">
                待发货：<span class="status-num" id="numSend">0</span>
            </div>
            <div class="status-item" data-code="21" onclick="filterByStatus(21)">
                待收货：<span class="status-num" id="numReceive">0</span>
            </div>
            <div class="status-item" data-code="23" onclick="filterByStatus(23)">
                已退款：<span class="status-num" id="numRefund">0</span>
            </div>
            <div class="status-item" data-code="30" onclick="filterByStatus(30)">
                已关闭：<span class="status-num" id="numClose">0</span>
            </div>
            <button class="clear-status-btn" onclick="clearStatusFilter()">清除状态筛选</button>
        </div>
        <div class="chart-row">
            <div class="chart-box">
                <canvas id="statusChart"></canvas>
            </div>
        </div>
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>下单时间</th>
                        <th>订单编号</th>
                        <th>物流单号</th>
                        <th>收货手机号</th>
                        <th>实际到手</th>
                        <th>收货地址</th>
                        <th>订单状态</th>
                    </tr>
                </thead>
                <tbody id="orderTableBody">
                </tbody>
            </table>
        </div>
    </div>
<script>
const SYNC_INTERVAL = 90 * 1000;
const STORAGE_KEY = "xianguanjia_order_list";
let allOrders = [];
let chartInstance = null;
let syncTimer = null;
let pageVisible = true;
let currentStatusCode = null;
const statusMap = {
    11: { code: 11, text: "待付款", class: "status-pay" },
    12: { code: 12, text: "待发货", class: "status-send" },
    21: { code: 21, text: "待收货", class: "status-receive" },
    22: { code: 22, text: "已完成｜正常完结", class: "status-finish" },
    23: { code: 23, text: "退款中", class: "status-refund" },
    24: { code: 24, text: "已退款（全额）", class: "status-refund" },
    25: { code: 25, text: "已退款（部分）", class: "status-refund" },
    30: { code: 30, text: "已关闭(取消/超时)", class: "status-close" },
    "待付款": { code: 11, text: "待付款", class: "status-pay" },
    "待发货": { code: 12, text: "待发货", class: "status-send" },
    "待收货": { code: 21, text: "待收货", class: "status-receive" },
    "交易成功": { code: 22, text: "已完成｜正常完结", class: "status-finish" },
    "正常完结": { code: 22, text: "已完成｜正常完结", class: "status-finish" },
    "退款中": { code: 23, text: "退款中", class: "status-refund" },
    "退款成功": { code: 24, text: "已退款（全额）", class: "status-refund" },
    "全额退款": { code: 24, text: "已退款（全额）", class: "status-refund" },
    "部分退款": { code: 25, text: "已退款（部分）", class: "status-refund" },
    "交易关闭": { code: 30, text: "已关闭(取消/超时)", class: "status-close" },
    "已关闭": { code: 30, text: "已关闭(取消/超时)", class: "status-close" }
};
const fieldAlias = {
    orderNo: ["order_no", "orderId", "order_id", "订单号", "tid"],
    orderTime: ["order_time", "createTime", "create_time", "下单时间", "pay_time"],
    logisticsNo: ["logistics_no", "expressNo", "express_no", "物流单号", "waybill_no"],
    phone: ["phone", "receiverPhone", "receiver_phone", "收货手机号", "buyer_phone"],
    amount: ["amount", "payAmount", "pay_amount", "订单金额", "total_fee", "payment"],
    refundAmount: ["refundAmount", "refund_amount", "退款金额", "refund_fee"],
    status: ["status", "orderStatus", "order_status", "订单状态", "status_str"],
    province: ["province", "receiverProvince", "省"],
    city: ["city", "receiverCity", "市"],
    district: ["district", "receiverDistrict", "区"],
    address: ["address", "receiverAddress", "收货地址", "detail_address"]
};
const mockApiData = [
    {
        order_time: 1783766400,
        order_no: "XY202607100001",
        logistics_no: "SF123456789001",
        phone: "13800000001",
        amount: 189.37,
        refund_amount: 0,
        province: "河南省",
        city: "郑州市",
        district: "金水区",
        address: "花园路街道张XX花园1号楼1单元101",
        status: "交易成功"
    },
    {
        order_time: 1783852800,
        order_no: "XY202607110002",
        logistics_no: "YT987654321002",
        phone: "13800000002",
        amount: 256.89,
        refund_amount: 20.00,
        province: "广东省",
        city: "深圳市",
        district: "南山区",
        address: "科技园李XX科技园B座503",
        status: "部分退款"
    },
    {
        order_time: 1784025600,
        order_no: "XY202607130003",
        logistics_no: "ZT112233445503",
        phone: "13800000003",
        amount: 321.45,
        refund_amount: 0,
        province: "浙江省",
        city: "杭州市",
        district: "西湖区",
        address: "文三路王XX大厦1202室",
        status: "交易成功"
    },
    {
        order_time: 1784198400,
        order_no: "XY202607150004",
        logistics_no: "YD556677889904",
        phone: "13800000004",
        amount: 158.62,
        refund_amount: 158.62,
        province: "江苏省",
        city: "苏州市",
        district: "姑苏区",
        address: "观前街刘XX巷18号院",
        status: "退款成功"
    },
    {
        order_time: 1784284800,
        order_no: "XY202607160005",
        logistics_no: "",
        phone: "13955556666",
        amount: 321.00,
        refund_amount: 0,
        province: "江苏省",
        city: "南京市",
        district: "鼓楼区",
        address: "XX大道陈XX大厦805室",
        status: "待发货"
    },
    {
        order_time: 1784371200,
        order_no: "XY202607170006",
        logistics_no: "",
        phone: "13512345678",
        amount: 189.50,
        refund_amount: 0,
        province: "河南省",
        city: "郑州市",
        district: "金水区",
        address: "XX路街道王XX花园1号楼1单元",
        status: "待发货"
    },
    {
        order_time: 1784457600,
        order_no: "XY202607180007",
        logistics_no: "JD6688997711",
        phone: "13200132000",
        amount: 369.00,
        refund_amount: 0,
        province: "河南省",
        city: "洛阳市",
        district: "涧西区",
        address: "南昌街道小九锦华苑5栋302",
        status: "待收货"
    },
    {
        order_time: 1784544000,
        order_no: "XY202607190008",
        logistics_no: "SF1234567890",
        phone: "13800138000",
        amount: 158.05,
        refund_amount: 0,
        province: "河南省",
        city: "洛阳市",
        district: "涧西区",
        address: "XX街道张XX小区3号楼2单元501",
        status: "待收货"
    }
];
function formatTime(timestamp) {
    if (!timestamp) return "-";
    const d = new Date(Number(timestamp) * 1000 || Number(timestamp));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return \`\${y}-\${m}-\${day} \${hh}:\${mm}:\${ss}\`;
}
function formatAmount(val) {
    return Number(val || 0).toFixed(2);
}
function getField(raw, targetField) {
    const aliases = fieldAlias[targetField] || [targetField];
    for (let key of aliases) {
        if (raw[key] !== undefined && raw[key] !== null) {
            return raw[key];
        }
    }
    return "";
}
function parseStatus(rawStatus) {
    return statusMap[rawStatus] || statusMap[30];
}
async function fetchOrders() {
    try {
        const res = await fetch("/api/orders");
        const data = await res.json();
        allOrders = data;
        document.getElementById("syncTip").innerText = \`● 已同步 \${allOrders.length} 条订单数据\`;
        refreshView();
    } catch (e) {
        console.log("拉取订单失败", e);
    }
}
function buildOrderItem(raw) {
    if (!raw) return null;
    const orderNo = getField(raw, "orderNo");
    if (!orderNo) return null;
    const rawStatus = getField(raw, "status");
    const statusInfo = parseStatus(rawStatus);
    const amount = Number(getField(raw, "amount") || 0);
    const refundAmount = Number(getField(raw, "refundAmount") || 0);
    const actualAmount = Math.max(0, amount - refundAmount);
    const province = getField(raw, "province");
    const city = getField(raw, "city");
    const district = getField(raw, "district");
    const address = getField(raw, "address");
    const fullAddress = \`\${province || ""}\${city || ""}\${district || ""}\${address || ""}\`;
    const rawTime = getField(raw, "orderTime");
    const orderTimeStr = formatTime(rawTime);
    const orderTimeDay = orderTimeStr.split(" ")[0];
    return {
        orderNo,
        orderTime: orderTimeStr,
        orderTimeDay,
        logisticsNo: getField(raw, "logisticsNo") || "",
        phone: getField(raw, "phone") || "",
        originalAmount: amount,
        refundAmount,
        actualAmount,
        fullAddress,
        status: statusInfo.code,
        statusText: statusInfo.text,
        statusClass: statusInfo.class,
        searchText: \`\${orderNo} \${getField(raw, "logisticsNo") || ""} \${getField(raw, "phone") || ""} \${fullAddress} \${statusInfo.text}\`
    };
}
function saveToLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allOrders));
}
function loadFromLocal() {
    const str = localStorage.getItem(STORAGE_KEY);
    if (str) {
        try {
            allOrders = JSON.parse(str);
        } catch (e) {
            allOrders = [];
        }
    }
}
function mergeOrders(newList) {
    newList.forEach(item => {
        const idx = allOrders.findIndex(o => o.orderNo === item.orderNo);
        if (idx >= 0) {
            allOrders[idx] = item;
        } else {
            allOrders.unshift(item);
        }
    });
    saveToLocal();
    refreshView();
}
async function manualSync() {
    document.getElementById("syncTip").innerText = "● 正在加载测试数据...";
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const list = mockApiData.map(buildOrderItem).filter(Boolean);
        mergeOrders(list);
        document.getElementById("syncTip").innerText = \`● 测试数据加载完成 | \${new Date().toLocaleString()}\`;
    } catch (e) {
        document.getElementById("syncTip").innerText = "○ 加载失败";
        console.error(e);
    }
}
function startAutoSync() {
    stopAutoSync();
    syncTimer = setInterval(() => {
        if (pageVisible) fetchOrders();
    }, SYNC_INTERVAL);
}
function stopAutoSync() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
}
document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
});
window.addEventListener("beforeunload", () => {
    stopAutoSync();
});
function filterByStatus(code) {
    currentStatusCode = code;
    document.querySelectorAll(".status-item").forEach(el => {
        el.classList.remove("active");
        if (Number(el.dataset.code) === code) {
            el.classList.add("active");
        }
    });
    refreshView();
}
function clearStatusFilter() {
    currentStatusCode = null;
    document.querySelectorAll(".status-item").forEach(el => {
        el.classList.remove("active");
    });
    refreshView();
}
function getFilteredOrders() {
    let start = document.getElementById("startDate").value.trim();
    let end = document.getElementById("endDate").value.trim();
    const keyword = document.getElementById("globalSearch").value.trim().toLowerCase();
    let list = [...allOrders];
    if (start && end && start > end) {
        [start, end] = [end, start];
    }
    if (start) {
        list = list.filter(item => item.orderTimeDay >= start);
    }
    if (end) {
        list = list.filter(item => item.orderTimeDay <= end);
    }
    if (currentStatusCode !== null) {
        if (currentStatusCode === 23) {
            list = list.filter(item => item.status === 23 || item.status === 24 || item.status === 25);
        } else {
            list = list.filter(item => item.status === currentStatusCode);
        }
    }
    if (keyword) {
        list = list.filter(item => item.searchText.toLowerCase().includes(keyword));
    }
    return list;
}
function resetFilter() {
    document.getElementById("globalSearch").value = "";
    document.getElementById("startDate").value = "";
    document.getElementById("endDate").value = "";
    clearStatusFilter();
}
function renderTable(list) {
    const tbody = document.getElementById("orderTableBody");
    if (!list.length) {
        tbody.innerHTML = \`<tr><td colspan="7" class="empty-tip">暂无匹配订单</td></tr>\`;
        return;
    }
    let html = "";
    list.forEach(item => {
        const refundMark = item.refundAmount > 0 
            ? \`<span class="refund-mark">（退\${formatAmount(item.refundAmount)}）</span>\` 
            : "";
        html += \`
        <tr>
            <td>\${item.orderTime}</td>
            <td>\${item.orderNo}</td>
            <td>\${item.logisticsNo || "-"}</td>
            <td>\${item.phone}</td>
            <td>¥\${formatAmount(item.actualAmount)}\${refundMark}</td>
            <td>\${item.fullAddress}</td>
            <td><span class="status-tag \${item.statusClass}">\${item.statusText}</span></td>
        </tr>\`;
    });
    tbody.innerHTML = html;
}
function renderStat(list) {
    const hasDateFilter = document.getElementById("startDate").value || document.getElementById("endDate").value;
    document.getElementById("countLabel").innerText = hasDateFilter ? "筛选订单总数" : "订单总数";
    document.getElementById("totalCount").innerText = list.length;
    const pendingStatus = new Set([12, 21]);
    let pendingSum = 0;
    list.filter(item => pendingStatus.has(item.status)).forEach(item => {
        pendingSum = Math.round((pendingSum + item.originalAmount) * 100) / 100;
    });
    document.getElementById("pendingAmount").innerText = formatAmount(pendingSum);
    const finishList = list.filter(item => item.status === 22);
    let finishSum = 0;
    finishList.forEach(item => {
        finishSum = Math.round((finishSum + item.actualAmount) * 100) / 100;
    });
    document.getElementById("finishCount").innerText = finishList.length;
    document.getElementById("finishAmount").innerText = formatAmount(finishSum);
}
function renderStatusBar(list) {
    let pay = 0, send = 0, receive = 0, finish = 0, refund = 0, close = 0;
    list.forEach(item => {
        switch (item.status) {
            case 11: pay++; break;
            case 12: send++; break;
            case 21: receive++; break;
            case 22: finish++; break;
            case 23:
            case 24:
            case 25: refund++; break;
            case 30: close++; break;
        }
    });
    document.getElementById("numPay").innerText = pay;
    document.getElementById("numSend").innerText = send;
    document.getElementById("numReceive").innerText = receive;
    document.getElementById("numFinish").innerText = finish;
    document.getElementById("numRefund").innerText = refund;
    document.getElementById("numClose").innerText = close;
}
function renderChart(list) {
    let pay = 0, send = 0, receive = 0, finish = 0, refund = 0, close = 0;
    list.forEach(item => {
        switch (item.status) {
            case 11: pay++; break;
            case 12: send++; break;
            case 21: receive++; break;
            case 22: finish++; break;
            case 23:
            case 24:
            case 25: refund++; break;
            case 30: close++; break;
        }
    });
    const ctx = document.getElementById("statusChart").getContext("2d");
    if (chartInstance) {
        chartInstance.destroy();
    }
    chartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: ["已完结", "待付款", "待发货", "待收货", "已退款", "已关闭"],
            datasets: [{
                label: "订单数量",
                data: [finish, pay, send, receive, refund, close],
                backgroundColor: ["#00b875", "#ff9100", "#0099ff", "#00c896", "#ff3366", "#666666"],
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true, ticks: { precision: 0 } }
            }
        }
    });
}
function refreshView() {
    const list = getFilteredOrders();
    renderTable(list);
    renderStat(list);
    renderStatusBar(list);
    renderChart(list);
}
window.onload = function () {
    loadFromLocal();
    fetchOrders();
    refreshView();
    startAutoSync();
    document.getElementById("startDate").addEventListener("input", refreshView);
    document.getElementById("endDate").addEventListener("input", refreshView);
    document.getElementById("globalSearch").addEventListener("input", refreshView);
};
</script>
</body>
</html>
    `;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(htmlContent);
  }

  // 404
  return res.status(404).send("404 Not Found");
};
