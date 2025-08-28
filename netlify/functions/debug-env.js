exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      PUBLIC_HMAC_KEY: process.env.PUBLIC_HMAC_KEY ? "(set)" : "(missing)",
      FORWARD_SECRET: process.env.FORWARD_SECRET ? "(set)" : "(missing)",
      // bonus: show the ROUTE_MAP targets you care about
      N8N_ONBOARD_SUBMIT_URL: process.env.N8N_ONBOARD_SUBMIT_URL ? "(set)" : "(missing)",
      N8N_ONBOARD_ACTIVATE_URL: process.env.N8N_ONBOARD_ACTIVATE_URL ? "(set)" : "(missing)",
      N8N_ONBOARD_RESEND_URL: process.env.N8N_ONBOARD_RESEND_URL ? "(set)" : "(missing)"
    })
  };
};
