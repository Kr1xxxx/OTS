// The only fake boundary is WhatsApp's external model API; adapter, bridge, UI,
// native protocol and SQLite remain production code in the integration tests.
async function installWhatsAppFixture(page) {
  await page.evaluate(() => {
    const wid = value => ({ _serialized:value, user:value.split('@')[0], server:value.split('@')[1] });
    window.fixtureWA = { account:'15550001111@c.us', peer:'15551234567@c.us', title:'Alice', ready:true,
      messages:[{ id:{ _serialized:'false_15551234567@c.us_AAA', remote:wid('15551234567@c.us'), fromMe:false }, type:'chat', body:'Could you send me the order update?', t:1700000000 }] };
    window.WPP = {
      get isReady() { return fixtureWA.ready; },
      conn:{ isAuthenticated:() => true, getMyUserId:() => wid(fixtureWA.account) },
      chat:{ getActiveChat:() => ({ id:wid(fixtureWA.peer), formattedTitle:fixtureWA.title, msgs:{ getModelsArray:() => fixtureWA.messages } }) },
      contact:{ getPnLidEntry:async () => ({}) }
    };
  });
}
module.exports = { installWhatsAppFixture };
