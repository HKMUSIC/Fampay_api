const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Serve HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let users = {}; // apiKey -> user data

// Create API Key
app.post('/create-api', (req, res) => {
  const { gmail, appPass, upi } = req.body;
  if (!gmail || !appPass || !upi) {
    return res.json({ status: "error", message: "All fields required" });
  }

  const apiKey = "GMS" + Math.random().toString(36).substring(2, 15).toUpperCase();
  users[apiKey] = { gmail, appPass, upi, orders: {} };

  res.json({ status: "success", apiKey, message: "API Created Successfully" });
});

// Generate QR
app.get('/api/qr', (req, res) => {
  const apiKey = req.query.api;
  const amount = parseInt(req.query.amount) || 10;

  if (!users[apiKey]) return res.json({ status: "error", message: "Invalid API Key" });

  const orderId = "FAMPAY" + Date.now();
  users[apiKey].orders[orderId] = { status: "pending", amount };

  res.json({
    status: "success",
    data: {
      order_id: orderId,
      qr_url: `https://api.gms.site/qr/${orderId}.png`,
      upi_id: users[apiKey].upi,
      amount: amount,
      created_at_ist: new Date().toLocaleString('en-IN'),
      expires_at_ist: new Date(Date.now() + 5*60000).toLocaleString('en-IN')
    }
  });
});

// Real Verify with IMAP
app.get('/api/verify', async (req, res) => {
  const apiKey = req.query.api_key;
  const orderId = req.query.order_id;

  if (!users[apiKey]) return res.json({ status: "error", message: "Invalid API Key" });

  const user = users[apiKey];
  const expectedAmount = user.orders[orderId]?.amount || 10; // Amount nikala

  try {
    // Ab checkPaymentInEmail mein OrderID ki jagah Expected Amount bhej rahe hain
    const result = await checkPaymentInEmail(user.gmail, user.appPass, expectedAmount);
    
    if (result.status === "success") {
      res.json({
        status: "success",
        data: {
          order_id: orderId,
          transaction_id: result.transaction_id,
          amount: expectedAmount,
          utr: result.utr,
          sender_name: result.sender,
          payment_time_ist: new Date().toLocaleString('en-IN')
        }
      });
    } else {
      res.json({
        status: "pending",
        message: "Payment verification in progress",
        order_id: orderId
      });
    }
  } catch (err) {
    res.json({ status: "error", message: "Verification failed" });
  }
});

// 🚀 ADVANCED IMAP FUNCTION (Based on your FamPay Email Screenshot)
async function checkPaymentInEmail(email, appPassword, expectedAmount) {
  const imap = require('imap');
  const { simpleParser } = require('mailparser');
  const Imap = imap;

  return new Promise((resolve) => {
    const client = new Imap({
      user: email,
      password: appPassword,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { servername: 'imap.gmail.com' }
    });

    client.once('ready', () => {
      client.openBox('INBOX', true, (err, box) => { // true = read-only mode
        if (err) return resolve({ status: "pending" });

        // 'successfully received' keyword search kar rahe hain email mein
        client.search(['UNSEEN', ['TEXT', 'successfully']], (err, results) => {
          if (err || !results || results.length === 0) {
            client.end();
            return resolve({ status: "pending" });
          }

          const fetch = client.fetch(results, { bodies: '' });
          const emailPromises = [];

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              emailPromises.push(new Promise((res) => {
                simpleParser(stream, (err, parsed) => {
                  res(parsed.text || "");
                });
              }));
            });
          });

          fetch.once('end', async () => {
            const emailsText = await Promise.all(emailPromises);
            let paymentFound = false;

            for (let text of emailsText) {
              // Regex checking based on FamPay UI text
              const amountMatch = text.match(/₹\s*([0-9]+(?:\.[0-9]+)?)/);
              let receivedAmount = amountMatch ? parseFloat(amountMatch[1]) : 0;

              // Check if email says successfully received and amount matches
              if (text.includes("successfully received") && receivedAmount === parseFloat(expectedAmount)) {
                paymentFound = true;
                
                // Screenshot wale format se data nikalna
                const utrMatch = text.match(/UTR\s*[:\r\n\s]*([0-9]{10,})/i);
                const txnMatch = text.match(/Transaction ID\s*[:\r\n\s]*([A-Z0-9]+)/i);
                const senderMatch = text.match(/from\s+([A-Za-z\s]+)/i);

                client.end();
                return resolve({
                  status: "success",
                  utr: utrMatch ? utrMatch[1] : "Not Found",
                  transaction_id: txnMatch ? txnMatch[1] : "FMPIB" + Date.now(),
                  sender: senderMatch ? senderMatch[1].trim() : "Unknown"
                });
              }
            }

            if (!paymentFound) {
              client.end();
              resolve({ status: "pending" });
            }
          });
        });
      });
    });

    client.once('error', () => resolve({ status: "pending" }));
    client.connect();
  });
}

// FIX FOR HEROKU
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GMS FamPay API running on port ${PORT}`);
});

