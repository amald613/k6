import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";
import { CONFIG } from "../config/config.js";

// Custom metrics
const banFailures = new Counter("ban_failures");
const unbanFailures = new Counter("unban_failures");
const banSuccessRate = new Rate("ban_successful_requests");
const unbanSuccessRate = new Rate("unban_successful_requests");

export const options = {
  scenarios: {
    ban_unban_users: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "30s", target: 3 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    "ban_failures": ["count<5"],
    "unban_failures": ["count<5"],
    "ban_successful_requests": ["rate>0.95"],
    "unban_successful_requests": ["rate>0.95"],
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.95"],
  },
};

// Setup: Login and fetch user list once
export function setup() {
  const loginUrl = `${CONFIG.baseUrl}/sign-in/email`;
  const credentials = {
    email: CONFIG.user.email,
    password: CONFIG.user.password,
  };

  const loginRes = http.post(loginUrl, JSON.stringify(credentials), {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });

  check(loginRes, {
    "✅ Login status is 200": (r) => r.status === 200,
  });

  const responseBody = loginRes.json();
  const token = responseBody.token;

  if (!token) {
    throw new Error("❌ Login failed — token not found");
  }

  let sessionCookie = "";
  if (loginRes.cookies && loginRes.cookies["__Secure-better-auth.session_token"]) {
    const cookieObj = loginRes.cookies["__Secure-better-auth.session_token"][0];
    sessionCookie = `${cookieObj.name}=${cookieObj.value}`;
  }

  const listUsersUrl = `${CONFIG.baseUrl}/admin/list-users`;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  const listRes = http.get(listUsersUrl, { headers });
  check(listRes, {
    "✅ List users status is 200": (r) => r.status === 200,
  });

  const users = listRes.json().users || [];
  if (!users.length) {
    throw new Error("❌ No users found in setup");
  }

  console.log(`✅ Setup complete — ${users.length} users loaded`);

  return {
    token,
    sessionCookie,
    users,
  };
}

// Default function: Ban and then unban users from setup
export default function (data) {
  const { token, sessionCookie, users } = data;

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  const banUserUrl = `${CONFIG.baseUrl}/admin/ban-user`;
  const unbanUserUrl = `${CONFIG.baseUrl}/admin/unban-user`;

  const targetUser = users[__ITER % users.length];

  // Step 1: Ban user
  const banPayload = {
    userId: targetUser.id,
    banReason: "",
    banExpiresIn: 604800,
  };

  const banRes = http.post(banUserUrl, JSON.stringify(banPayload), { headers });

  if (banRes.status === 200) {
    const resBody = banRes.json();
    check(banRes, {
      "✅ Ban user status is 200": (r) => r.status === 200,
      "✅ User is marked as banned": (r) => resBody.user?.banned === true,
    });
    banSuccessRate.add(1);
    console.log(`🚫 Banned: ${resBody.user?.name} (${resBody.user?.email}) until ${resBody.user?.banExpires}`);
  } else {
    console.error(`❌ Ban failed: ${banRes.status} - ${banRes.body}`);
    check(banRes, {
      "❌ Ban user failed": (r) => false,
    });
    banFailures.add(1);
    banSuccessRate.add(0);
    sleep(1);
    return;
  }

  sleep(1); // simulate delay

  // Step 2: Unban user
  const unbanPayload = {
    userId: targetUser.id,
  };

  const unbanRes = http.post(unbanUserUrl, JSON.stringify(unbanPayload), { headers });

  if (unbanRes.status === 200) {
    const resBody = unbanRes.json();
    check(unbanRes, {
      "✅ Unban user status is 200": (r) => r.status === 200,
      "✅ User is marked as unbanned": (r) => resBody.user?.banned === false,
    });
    unbanSuccessRate.add(1);
    console.log(`🔓 Unbanned: ${resBody.user?.name} (${resBody.user?.email})`);
  } else {
    console.error(`❌ Unban failed: ${unbanRes.status} - ${unbanRes.body}`);
    check(unbanRes, {
      "❌ Unban user failed": (r) => false,
    });
    unbanFailures.add(1);
    unbanSuccessRate.add(0);
  }

  sleep(1);
}

export function teardown() {
  console.log("\n📊 BAN + UNBAN USER TEST COMPLETE");
}
