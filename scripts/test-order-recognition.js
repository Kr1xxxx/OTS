#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trade-order-system.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'mac-app', 'server.js'), 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const releaseVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : ['2026-08-17T12:00:00Z']));
  }
  static now() { return new Date('2026-08-17T12:00:00Z').getTime(); }
}

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {
      // Keep scanning until the complete production function compiles.
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

const context = vm.createContext({
  console,
  Date: FixedDate,
  location: { protocol: 'http:', hostname: '127.0.0.1', port: '49123' },
  nowText: () => '2026-08-11 12:00',
  normalizeDate: value => String(value || '').slice(0, 10),
  money: value => `$${Number(value || 0)}`,
  clientDisplayName: value => String(value || '').trim(),
  stageDef: stage => ({ name: stage === 'done' ? '已完成' : '已发货' }),
  normalizeStage: value => String(value || '').trim().toLowerCase(),
  depositPercent: (amount, paid) => Number(amount || 0) > 0 ? Math.round((Number(paid || 0) / Number(amount)) * 100) : 0,
  productTypeDefs: [{ value: '假发' }, { value: '睫毛' }],
  paymentChannelDefs: [{ value: '阿里巴巴' }, { value: 'Paypal' }, { value: '西联' }, { value: 'Zelle' }, { value: '信用卡' }, { value: 'TT' }],
  orderTypeDefs: [{ value: '定金订单' }, { value: '全款订单' }],
  countryDefs: [
    '🇺🇸 美国 United States',
    '🇨🇦 加拿大 Canada',
    '🇩🇪 德国 Germany',
    '🇬🇧 英国 United Kingdom',
    '🇫🇷 法国 France',
    '🇮🇹 意大利 Italy',
    '🇪🇸 西班牙 Spain',
    '🇦🇺 澳大利亚 Australia',
    '🌐 其他 Other'
  ],
  currencyDefs: [{ code: 'USD' }, { code: 'EUR' }, { code: 'GBP' }, { code: 'CNY' }, { code: 'AUD' }, { code: 'CAD' }],
  usStateNamePattern: 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia',
  canadaProvinceNamePattern: 'Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland and Labrador|Nova Scotia|Ontario|Prince Edward Island|Quebec|Saskatchewan|Northwest Territories|Nunavut|Yukon',
  state: { orders: [], customers: {} },
  defaultOrderSettings: { defaultProductType: '假发', defaultPaymentChannel: 'Paypal', defaultOrderType: '全款订单' },
  defaultAiSettings: { enabled: '否', provider: 'zhipu', apiKey: '', apiKeySaved: false, apiKeyMask: '', baseUrl: 'https://example.test/v1', model: 'glm-4.7-flashx', lastTestAt: '', lastTestStatus: '尚未测试连接' }
});
context.clientHistory = () => Object.entries(context.state.customers || {}).map(([name, profile]) => ({ client: name, ...profile }));
// Load the shared production labels used by both read-only and editable previews.
vm.runInContext(html.match(/^const localCustomerLabelDefs = \[[\s\S]*?\];$/m)[0].replace('const ','var ') + html.match(/^const localCustomerLabelPattern = .*$/m)[0].replace('const ','var ') + html.match(/^const localCustomerNameStopWords = .*$/m)[0].replace('const ','var '), context);
vm.runInContext(html.match(/^const customerPasteLabels = .*;$/m)[0], context);
[
  'isMacAppMode',
  'existingCustomerKey',
  'maskSecret',
  'normalizeAiSettings',
  'localAiSettings',
  'customerAddressCopyText',
  'normalizeSearchText',
  'boundedDamerauLevenshtein',
  'cleanTracking',
  'isUpsTrackingNumber',
  'carrierHintFromTrackingText',
  'detectCarrier',
  'normalizeCountry',
  'roundMoneyValue',
  'findAmountInText',
  'findOrderCreatedAtInText',
  'findPartialPaymentInText',
  'countrySearchParts',
  'textContainsCountryAlias',
  'findCountryInText',
  'findCurrencyInText',
  'findProductTypeInText',
  'findPaymentChannelInText',
  'normalizePaymentChannelValue',
  'hasTrackingSignalText',
  'hasPhoneSignalText',
  'trackingCandidatesFromLine',
  'findTrackingInText',
  'matchOrdersFromPaste',
  'decodePasteEntities',
  'decodeCustomerNameEntities',
  'customerNameMatchTokens',
  'customerNameTokensFuzzyMatch',
  'normalizeCustomerValueList',
  'normalizeCustomerContactFields',
  'splitCustomerPhoneValues',
  'findCustomerPhonesInText',
  'customerPostalCodes',
  'customerAddressMatchEvidence',
  'isAutomaticClientMatch',
  'matchClientsFromPaste',
  'findExplicitNoteInText',
  'analyzePasteText',
  'deobfuscateEmailText',
  'sellerSideCustomerLines',
  'sellerSideEmails',
  'normalizeCustomerEmail',
  'findEmailsInText',
  'findEmailInText',
  'normalizeCustomerPhoneDigits',
  'normalizeCustomerPhone',
  'findCustomerPhoneInText',
  'findPaymentEmailInText',
  'customerPasteLines',
  'labeledCustomerValue',
  'hasCustomerFieldLabel',
  'isCustomerPhoneLine',
  'isOrderInfoLine',
  'isCityStateZipLine',
  'isSpainAddressText',
  'isUsCityStateZipText',
  'isCanadaProvincePostalText',
  'isUkPostcodeText',
  'isStreetAddressLine',
  'isAddressUnitLine',
  'isUsZipOnlyLine',
  'isCityStateOnlyLine',
  'isLooseStreetAddressLine',
  'isAddressContinuationLine',
  'isLikelyCustomerNameLine',
  'cleanCustomerNameCandidate',
  'customerNameFromMixedLine',
  'bestCustomerNameCandidate',
  'inlineCustomerAddressBlock',
  'unlabeledCustomerBlock',
  'stripTrailingOrderFieldsFromAddress',
  'findCustomerAddressInText',
  'looksLikeAddressText',
  'cleanContactValue',
  'findContactInText',
  'findCustomerNameInText',
  'findCustomerLevelInText',
  'findRepurchaseCycleInText',
  'findCustomerCountryFieldInText',
  'findCustomerCurrencyFieldInText',
  'findCustomerProductFieldInText',
  'findCustomerPaymentMethodFieldInText',
  'findCustomerPaymentEmailFieldInText',
  'findCustomerTagsInText',
  'autoCapitalizeCustomerName',
  'normalizeTags',
  'localCustomerLabelField',
  'localCustomerSegments',
  'localCustomerPersonName',
  'localCustomerLeadingName',
  'localCustomerSentenceCompany',
  'localCustomerCompanyName',
  'isLocalStreetLine',
  'isLocalTailAddressLine',
  'isLocalCountryLine',
  'isLocalAddressLine',
  'localCustomerAddresses',
  'localCustomerPhones',
  'localCustomerEmails',
  'localCustomerContactFields',
  'localCustomerCountry',
  'localCustomerPaymentMethod',
  'analyzeCustomerPasteText',
  'customerFieldsFromCombinedPaste',
  'orderFieldsFromCombinedPaste',
  'combinedPasteCreatePreview',
  'pasteFieldLabels',
  'customerPasteFieldLabels',
  'combinedPastePreviewHtml',
  'escapeAttr',
  'isSettledStage',
  'orderAmountValue',
  'orderPaidValue',
  'orderDueValue',
  'applyStagePaymentInvariant',
  'applyOrderStageInvariants',
  'normalizeOrderPaymentInput',
  'normalizeOrderProductType',
  'normalizeOrderPaymentChannel',
  'normalizeOrderSettings',
  'patchOrdersForCustomerRename',
  'customerNameCollision',
  'ecbUsdRateForOrder',
  'orderAmountUsd',
  'orderPaidUsd',
  'orderDueUsd',
  'usdTotal',
  'usdPaidTotal',
  'usdDueTotal'
]
  .forEach(name => vm.runInContext(extractFunction(name), context));
vm.runInContext('var ecbHistoricalRates = [];', context);

function recognize(text) {
  const amount = vm.runInContext(`findAmountInText(${JSON.stringify(text)})`, context);
  const payment = vm.runInContext(`findPartialPaymentInText(${JSON.stringify(text)}, ${JSON.stringify(amount)})`, context);
  return { amount, ...payment };
}

function evaluateJson(expression) {
  return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
}

const imogenUkAddress = 'Alex Example +44, 123 Sample Rd, Sample Road 123, PR2 2LE, Preston, England, United Kingdom';
const imogenFields = evaluateJson(`analyzeCustomerPasteText(${JSON.stringify(imogenUkAddress)}).extracted`);
assert.equal(imogenFields.name, 'Alex Example', 'UK alphanumeric postcode must not block inline name');
assert.equal(imogenFields.address, '123 Sample Rd, Sample Road 123, PR2 2LE, Preston, England, United Kingdom');
assert.equal(imogenFields.phone, undefined, 'partial international code must not become phone');

assert.deepEqual(
  recognize('Morgan sample 1022美金，付款一半'),
  { amount: 1022, orderType: '定金订单', paidAmount: 511, depositAmount: 511, depositPercent: 50 }
);
assert.deepEqual(
  recognize('Morgan Sample USD 1021，50%预付'),
  { amount: 1021, orderType: '定金订单', paidAmount: 510.5, depositAmount: 510.5, depositPercent: 50 }
);
assert.deepEqual(
  recognize('Morgan Sample USD 1022 paid half'),
  { amount: 1022, orderType: '定金订单', paidAmount: 511, depositAmount: 511, depositPercent: 50 }
);
assert.deepEqual(recognize('Morgan Sample 1022美金，已付全款'), { amount: 1022 });
assert.deepEqual(recognize('Morgan Sample 1022美金，产品打五折'), { amount: 1022 });

const ordinaryPasteWithoutNote = `客户：Taylor Morgan
Total USD 1000
Please deliver before September 15`;
assert.equal(
  evaluateJson(`analyzePasteText(${JSON.stringify(ordinaryPasteWithoutNote)})`).extracted.note,
  undefined,
  '普通聊天原文不能自动写入订单备注'
);
assert.equal(
  evaluateJson(`analyzeCustomerPasteText(${JSON.stringify(ordinaryPasteWithoutNote)})`).extracted.note,
  undefined,
  '普通客户资料原文不能自动写入客户备注'
);
assert.equal(
  evaluateJson(`orderFieldsFromCombinedPaste(${JSON.stringify(ordinaryPasteWithoutNote)}, {})`).note,
  undefined,
  '客户与订单联合识别不能把整段原文写入订单备注'
);
assert.equal(
  evaluateJson(`customerFieldsFromCombinedPaste(${JSON.stringify(ordinaryPasteWithoutNote)})`).note,
  undefined,
  '客户与订单联合识别不能把整段原文写入客户备注'
);

const explicitlyLabeledNotes = `客户：Taylor Morgan
Total USD 1000
客户备注：偏好邮件联系
订单备注：分两箱发货`;
assert.equal(evaluateJson(`analyzePasteText(${JSON.stringify(explicitlyLabeledNotes)})`).extracted.note, '分两箱发货');
assert.equal(evaluateJson(`analyzeCustomerPasteText(${JSON.stringify(explicitlyLabeledNotes)})`).extracted.note, '偏好邮件联系');
assert.equal(evaluateJson(`analyzePasteText(${JSON.stringify('Total USD 500\nRemark: Pack separately')})`).extracted.note, 'Pack separately');

[
  'Shipping is arranged tomorrow',
  'Happy Beauty LLC',
  'Please contact support',
  'Wireless order update',
  'Discard the old quotation',
  'Northwestern Beauty Supply'
].forEach(text => {
  assert.equal(vm.runInContext(`findPaymentChannelInText(${JSON.stringify(text)})`, context), '', `普通单词不能误识别付款方式：${text}`);
});
[
  ['Payment: PayPal', 'Paypal'],
  ['Payment: PP', 'Paypal'],
  ['Payment: Western Union', '西联'],
  ['Payment: Zelle', 'Zelle'],
  ['Payment: credit card', '信用卡'],
  ['Payment: TT', 'TT'],
  ['Payment: T/T', 'TT'],
  ['Payment: wire transfer', 'TT'],
  ['Payment: Alibaba', '阿里巴巴']
].forEach(([text, expected]) => {
  assert.equal(vm.runInContext(`findPaymentChannelInText(${JSON.stringify(text)})`, context), expected);
});

assert.equal(vm.runInContext(`findProductTypeInText(${JSON.stringify('Flash Beauty LLC')})`, context), '', 'Flash 不能因为包含 lash 被识别为睫毛');
assert.equal(vm.runInContext(`findProductTypeInText(${JSON.stringify('Chair Design Studio')})`, context), '', 'Chair 不能因为包含 hair 被识别为假发');
assert.equal(vm.runInContext(`findProductTypeInText(${JSON.stringify('Products: lashes and tweezers')})`, context), '睫毛');
assert.equal(vm.runInContext(`findProductTypeInText(${JSON.stringify('Products: wig and hair bundles')})`, context), '假发');

assert.equal(
  evaluateJson(`analyzePasteText(${JSON.stringify('客户：Taylor Morgan\n9月15日交货\nTotal USD 1000')})`).extracted.createdAt,
  undefined,
  '交货日期不能写入下单日期'
);
assert.equal(
  evaluateJson(`analyzePasteText(${JSON.stringify('Expected delivery 2026-09-15\nTotal USD 1000')})`).extracted.createdAt,
  undefined,
  '英文交货日期不能写入下单日期'
);
assert.equal(vm.runInContext(`findOrderCreatedAtInText(${JSON.stringify('下单日期：9月1日')})`, context), '2026-09-01');
assert.equal(vm.runInContext(`findOrderCreatedAtInText(${JSON.stringify('Order date: 2026-09-01')})`, context), '2026-09-01');

const twoUnlabeledEmails = evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('Taylor Morgan\nbuyer@example.com\naccounts@example.com')})`).extracted;
assert.equal(twoUnlabeledEmails.email, 'buyer@example.com');
assert.equal(twoUnlabeledEmails.paymentEmail, undefined, '第二个未标注邮箱不能自动当作付款邮箱');
assert.equal(
  vm.runInContext(`normalizeCustomerEmail(${JSON.stringify(' mailto:Buyer@Example.com?subject=Order ')})`, context),
  'Buyer@Example.com',
  '邮箱输入必须自动移除 mailto: 和 URL 查询参数'
);
assert.equal(
  evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('Jill Sample&#x20;\n123 Sample Lane #7, Las Vegas, NV 89183\nUnited States')})`).extracted.name,
  'Jill Sample',
  '网页实体空格不能导致客户姓名识别失败'
);
assert.equal(
  evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('邮箱：buyer@example.com\n付款邮箱：accounts@example.com')})`).extracted.paymentEmail,
  'accounts@example.com'
);

assert.equal(
  evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('客户：Taylor Morgan\n邮箱：buyer@example.com')})`).extracted.country,
  undefined,
  '没有国家信息时不能自动填入“其他”'
);
[
  '客户：Gold Coast Beauty',
  '客户：Silver Spring Lashes',
  '客户：Diamond Bar Supply',
  '地址：Emerald Road 18',
  '客户：Platinum Beauty LLC'
].forEach(text => {
  assert.equal(evaluateJson(`analyzeCustomerPasteText(${JSON.stringify(text)})`).extracted.level, undefined, `公司名或地址不能误识别客户等级：${text}`);
});
assert.equal(evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('客户：Taylor Morgan\n客户等级：A级钻石客户')})`).extracted.level, 'A级钻石客户');

[
  '客户：Sample Beauty LLC',
  '客户：VIP Nails Ltd',
  '地址：Repeat Road 8',
  '地址：Monthly Lane 5'
].forEach(text => {
  assert.equal(evaluateJson(`analyzeCustomerPasteText(${JSON.stringify(text)})`).extracted.tags, undefined, `公司名或地址不能误识别客户标签：${text}`);
});
assert.equal(
  evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('客户：Taylor Morgan\n客户标签：样品客户, 高复购')})`).extracted.tags,
  '样品客户, 高复购'
);

assert.equal(
  vm.runInContext(`findCustomerPhoneInText(${JSON.stringify('电话：+1 202 555 0127\n备用电话：+1 202 555 0111')})`, context),
  '+1 202 555 0127; +1 202 555 0111',
  '多个电话号码应全部保留并去重'
);

assert.equal(vm.runInContext(`findAmountInText(${JSON.stringify('Shipping fee USD 80')})`, context), '', '运费不能作为订单金额');
assert.equal(vm.runInContext(`findAmountInText(${JSON.stringify('运费 USD 80')})`, context), '', '中文运费不能作为订单金额');
assert.equal(vm.runInContext(`findAmountInText(${JSON.stringify('Total USD 1000\nShipping fee USD 80')})`, context), 1000);
assert.equal(vm.runInContext(`findAmountInText(${JSON.stringify('USD 1022')})`, context), 1022);

const imanPasteText = `Evan Sampleton+44 7700 900127
18 Sample Rd, Sample Road 18, E15 3DQ, London, England, United Kingdom  473美元
下单日期：7月21日`;
assert.equal(vm.runInContext(`cleanCustomerNameCandidate(${JSON.stringify('Evan Sampleton')})`, context), 'Evan Sampleton');
assert.equal(vm.runInContext(`customerNameFromMixedLine(${JSON.stringify('Evan Sampleton+44 7700 900127')})`, context), 'Evan Sampleton');
assert.equal(vm.runInContext(`findCustomerNameInText(${JSON.stringify(imanPasteText)})`, context), 'Evan Sampleton');
const imanPreview = evaluateJson(`combinedPasteCreatePreview(${JSON.stringify(imanPasteText)})`);
assert.deepEqual({
  canCreate: imanPreview.canCreate,
  customerStatus: imanPreview.customerStatus,
  customer: {
    name: imanPreview.customerFields.name,
    phone: imanPreview.customerFields.phone,
    country: imanPreview.customerFields.country,
    address: imanPreview.customerFields.address
  },
  order: {
    amount: imanPreview.orderFields.amount,
    currency: imanPreview.orderFields.currency,
    country: imanPreview.orderFields.country,
    createdAt: imanPreview.orderFields.createdAt
  }
}, {
  canCreate: true,
  customerStatus: 'new',
  customer: {
    name: 'Evan Sampleton',
    phone: '+44 7700 900127',
    country: '🇬🇧 英国 United Kingdom',
    address: '18 Sample Rd, Sample Road 18, E15 3DQ, London, England, United Kingdom'
  },
  order: {
    amount: 473,
    currency: 'USD',
    country: '🇬🇧 英国 United Kingdom',
    createdAt: '2026-07-21'
  }
});
assert.match(
  vm.runInContext(`combinedPastePreviewHtml(${JSON.stringify(imanPreview)}, 'data-test')`, context),
  /识别为新客户：Evan Sampleton/
);

context.state.customers = {
  'Saved London Client': {
    phone: '+44 7700 900127',
    country: '🇬🇧 英国 United Kingdom'
  }
};
const phoneMatchedAnalysis = evaluateJson(`analyzePasteText(${JSON.stringify('Different Display Name +44 7700 900127')})`);
assert.equal(phoneMatchedAnalysis.clientMatches[0]?.client?.client, 'Saved London Client');
assert.equal(phoneMatchedAnalysis.clientMatches[0]?.score, 100);
assert.equal(phoneMatchedAnalysis.clientMatches[0]?.reason, '电话号码一致');
context.state.customers = {};

context.state.customers = {
  'Saved Email Client': {
    email: 'buyer@example.com',
    phone: '+1 202 555 0199'
  }
};
const emailMatchedAnalysis = evaluateJson(`analyzePasteText(${JSON.stringify('New order contact: Buyer@Example.com')})`);
assert.equal(emailMatchedAnalysis.clientMatches[0]?.client?.client, 'Saved Email Client');
assert.equal(emailMatchedAnalysis.clientMatches[0]?.score, 100);
assert.equal(emailMatchedAnalysis.clientMatches[0]?.reason, '邮箱一致');
context.state.customers = {};

context.state.customers = {
  'Note Number Client': {
    phone: '+1 202 555 0111',
    note: '旧备注曾提到 +1 202 555 0127'
  }
};
const notePhoneMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('Taylor Morgan +1 202 555 0127')})`);
assert.deepEqual(notePhoneMatches, [], '备注中的数字不能冒充客户电话号码');
context.state.customers = {};

context.state.customers = {
  'Taylor Morgan': {
    phone: '+1 202 555 0127',
    country: '🇺🇸 美国 United States'
  }
};
const exactNameMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Taylor Morgan\n订单金额: USD 1022')})`);
assert.equal(exactNameMatches[0]?.client?.client, 'Taylor Morgan');
assert.equal(exactNameMatches[0]?.score, 95);
assert.equal(exactNameMatches[0]?.reason, '姓名完全一致');
context.state.customers = {};

context.state.customers = {
  'Taylor Morgan': {
    phone: '+1 202 555 0127'
  }
};
const reorderedNameMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Morgan Taylor\n订单金额: USD 1022')})`);
assert.equal(reorderedNameMatches[0]?.client?.client, 'Taylor Morgan');
assert.equal(reorderedNameMatches[0]?.score, 88);
assert.equal(reorderedNameMatches[0]?.reason, '姓名顺序相似');
context.state.customers = {};

context.state.customers = {
  'Evan Sampleton': {
    phone: '+44 7700 900127'
  }
};
const misspelledNameMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Evan Sampletno\n金额: USD 473')})`);
assert.equal(misspelledNameMatches[0]?.client?.client, 'Evan Sampleton');
assert.equal(misspelledNameMatches[0]?.score, 85);
assert.equal(misspelledNameMatches[0]?.reason, '姓名相似，需确认');
const fuzzyOrderAnalysis = evaluateJson(`analyzePasteText(${JSON.stringify('客户: Evan Sampletno\n金额: USD 473')})`);
assert.equal(fuzzyOrderAnalysis.extracted.client, undefined, '姓名模糊候选不能自动套用到订单');
const fuzzyCustomerAnalysis = evaluateJson(`analyzeCustomerPasteText(${JSON.stringify('客户: Evan Sampletno\n金额: USD 473')})`);
assert.equal(fuzzyCustomerAnalysis.extracted.name, 'Evan Sampletno', '姓名模糊候选不能覆盖识别出的客户名');
context.state.customers = {};

context.state.customers = {
  'Alice Brown': {
    phone: '+1 585 555 0188',
    address: 'Rochester, New York, United States'
  }
};
const addressSubstringMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('Taylor Morgan +1 2025550127, Suite 101, 123 browncroft blvd, Rochester, New York, 14625, United States of America')})`);
assert.deepEqual(addressSubstringMatches, [], '地址单词不能作为客户姓名子串产生匹配');
context.state.customers = {};

context.state.customers = {
  Brown: {
    phone: '+1 585 555 0101'
  }
};
const singleNameAddressMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('Taylor Morgan +1 2025550127, Suite 101, 123 browncroft blvd, Rochester, New York, 14625, United States of America')})`);
assert.deepEqual(singleNameAddressMatches, [], '单个客户名只能匹配姓名字段，不能命中地址子串');
context.state.customers = {};

assert.equal(vm.runInContext(`autoCapitalizeCustomerName(${JSON.stringify('Alice Brown&#x20;')})`, context), 'Alice Brown');
context.state.customers = {
  'Alice Brown&#x20;': {
    phone: '+1 585 555 0102'
  }
};
const encodedNameMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Alice Brown\n订单金额: USD 800')})`);
assert.equal(encodedNameMatches[0]?.client?.client, 'Alice Brown&#x20;');
assert.equal(encodedNameMatches[0]?.score, 95);
assert.equal(encodedNameMatches[0]?.reason, '姓名完全一致');
context.state.customers = {};

context.state.customers = {
  'Multi Contact Client': {
    phone: '+1 202 555 0111; +44 7700 900127',
    email: 'primary@example.com; sales@example.com',
    paymentEmail: 'billing@example.com'
  }
};
const secondaryPhoneMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Other Name\n电话: +1 404 555 0199\n备用电话: +44 7700 900127')})`);
assert.equal(secondaryPhoneMatches[0]?.client?.client, 'Multi Contact Client');
assert.equal(secondaryPhoneMatches[0]?.score, 100);
assert.equal(secondaryPhoneMatches[0]?.reason, '第2个电话号码一致');
const secondaryEmailMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify('客户: Other Name\n邮箱: sales@example.com')})`);
assert.equal(secondaryEmailMatches[0]?.client?.client, 'Multi Contact Client');
assert.equal(secondaryEmailMatches[0]?.score, 100);
assert.equal(secondaryEmailMatches[0]?.reason, '第2个邮箱一致');
context.state.customers = {};

context.state.customers = {
  'Evan Sampleton': {
    address: '18 Sample Road, London, E15 3DQ, United Kingdom',
    country: '🇬🇧 英国 United Kingdom'
  },
  'Different Person': {
    address: '18 Sample Road, London, E15 3DQ, United Kingdom',
    country: '🇬🇧 英国 United Kingdom'
  }
};
const corroboratedNameText = '客户: Evan Sampletno\n地址: 18 Sample Road, London, E15 3DQ, United Kingdom';
const corroboratedNameMatches = evaluateJson(`matchClientsFromPaste(${JSON.stringify(corroboratedNameText)})`);
assert.equal(corroboratedNameMatches[0]?.client?.client, 'Evan Sampleton');
assert.ok(corroboratedNameMatches[0]?.score >= 90, '姓名轻微错字且地址、邮编一致时应达到自动匹配门槛');
assert.match(corroboratedNameMatches[0]?.reason || '', /姓名相似/);
assert.match(corroboratedNameMatches[0]?.reason || '', /邮编一致/);
const corroboratedOrderAnalysis = evaluateJson(`analyzePasteText(${JSON.stringify(corroboratedNameText)})`);
assert.equal(corroboratedOrderAnalysis.extracted.client, 'Evan Sampleton');
assert.equal(corroboratedNameMatches.some(item => item.client.client === 'Different Person'), false, '只有地址一致且姓名不同不能产生客户候选');
context.state.customers = {};

const vanessaOrders = [
  { amount:1936, paidAmount:968, currency:'USD', stage:'shipment', orderType:'定金订单', depositAmount:968, depositPercent:50, logs:[] },
  { amount:1022, paidAmount:511, currency:'USD', stage:'deposit', orderType:'定金订单', depositAmount:511, depositPercent:50, logs:[] }
];
context.vanessaOrders = vanessaOrders;
assert.equal(vm.runInContext('usdTotal(vanessaOrders)', context), 2958);
assert.equal(vm.runInContext('usdPaidTotal(vanessaOrders)', context), 2447);
assert.equal(vm.runInContext('usdDueTotal(vanessaOrders)', context), 511);
assert.equal(vm.runInContext('applyStagePaymentInvariant(vanessaOrders[0], "shipment")', context), true);
assert.equal(vanessaOrders[0].paidAmount, 1936);
assert.equal(vanessaOrders[0].orderType, '定金订单');
assert.equal(vanessaOrders[0].depositAmount, 968);
assert.equal(vanessaOrders[0].depositPercent, 50);

assert.deepEqual(
  evaluateJson(`normalizeOrderPaymentInput({ paidAmount:600, depositAmount:300, depositPercent:30 }, 1000, '定金订单', 'balance')`),
  { paidAmount: 600, depositAmount: 300, depositPercent: 30 }
);
assert.deepEqual(
  evaluateJson(`normalizeOrderPaymentInput({ depositAmount:300, depositPercent:30 }, 1000, '定金订单', 'quote')`),
  { paidAmount: 0, depositAmount: 300, depositPercent: 30 }
);
assert.deepEqual(
  evaluateJson(`normalizeOrderPaymentInput({}, 1000, '全款订单', 'quote')`),
  { paidAmount: 0, depositAmount: 1000, depositPercent: 100 }
);
assert.deepEqual(
  evaluateJson(`normalizeOrderPaymentInput({ paidAmount:300, depositAmount:300, depositPercent:30 }, 1000, '定金订单', 'shipment')`),
  { paidAmount: 1000, depositAmount: 300, depositPercent: 30 }
);

const shipmentOrder = {
  amount: 1000,
  paidAmount: 300,
  currency: 'USD',
  stage: 'production',
  orderType: '定金订单',
  depositAmount: 300,
  depositPercent: 30,
  logisticsStatus: '未发货',
  shippedAt: '',
  logs: []
};
context.shipmentOrder = shipmentOrder;
assert.equal(vm.runInContext(`applyOrderStageInvariants(shipmentOrder, 'shipment')`, context), true);
assert.equal(shipmentOrder.paidAmount, 1000);
assert.equal(shipmentOrder.depositAmount, 300);
assert.equal(shipmentOrder.logisticsStatus, '已发货');
assert.equal(shipmentOrder.shippedAt, '2026-08-11');

const historicalOrders = [{
  id: 'o-history',
  client: 'Morgan Sample',
  country: 'Spain',
  currency: 'USD',
  owner: 'Kris',
  amount: 1022,
  updated: '2026-06-01 10:00'
}];
context.historicalOrders = historicalOrders;
const renamedOrders = evaluateJson(`patchOrdersForCustomerRename(historicalOrders, 'Morgan Sample', 'Morgan Sample SL')`);
assert.deepEqual(renamedOrders, [{
  id: 'o-history',
  client: 'Morgan Sample SL',
  country: 'Spain',
  currency: 'USD',
  owner: 'Kris',
  amount: 1022,
  updated: '2026-06-01 10:00'
}]);
context.customerRecords = { 'Morgan Sample': {}, 'Other Client': {} };
assert.equal(vm.runInContext(`customerNameCollision(customerRecords, '', 'morgan sample')`, context), 'Morgan Sample');
assert.equal(vm.runInContext(`customerNameCollision(customerRecords, 'Morgan Sample', 'MORGAN SAMPLE')`, context), '');

assert.equal(vm.runInContext(`normalizeOrderProductType('假发')`, context), '假发');
assert.equal(vm.runInContext(`normalizeOrderProductType('')`, context), '假发');
assert.equal(vm.runInContext(`normalizeOrderPaymentChannel('TT')`, context), 'TT');
assert.equal(vm.runInContext(`normalizeOrderPaymentChannel('')`, context), 'Paypal');
assert.deepEqual(
  evaluateJson(`normalizeOrderSettings({ defaultPaymentChannel:'TT', defaultOrderType:'定金订单' })`),
  { defaultProductType: '睫毛', defaultPaymentChannel: 'TT', defaultOrderType: '定金订单', productDefaultRevision:1 }
);

assert.equal(vm.runInContext(`isMacAppMode()`, context), true);
context.location.port = '61234';
assert.equal(vm.runInContext(`isMacAppMode()`, context), true);
context.location.hostname = 'localhost';
assert.equal(vm.runInContext(`isMacAppMode()`, context), true);
context.location.hostname = 'example.com';
assert.equal(vm.runInContext(`isMacAppMode()`, context), false);
context.location.hostname = '127.0.0.1';
context.location.protocol = 'https:';
assert.equal(vm.runInContext(`isMacAppMode()`, context), false);
context.location.protocol = 'http:';
assert.deepEqual(
  evaluateJson(`localAiSettings({ apiKey:'secret-api-key', apiKeySaved:false, apiKeyMask:'', model:'glm-5.1' })`),
  {
    enabled: '否', provider: 'zhipu', apiKey: '', apiKeySaved: true, apiKeyMask: 'sec******key',
    baseUrl: 'https://example.test/v1', model: 'glm-5.1', lastTestAt: '', lastTestStatus: '尚未测试连接'
  }
);

assert.equal(
  vm.runInContext(`customerAddressCopyText({ client:'Evan Sampleton', address:'18 Sample Road, London', phone:'+44 7700 900127', email:'evan@example.com', paymentEmail:'payments@example.com' })`, context),
  'Evan Sampleton\n18 Sample Road, London\n电话：+44 7700 900127\n邮箱：evan@example.com'
);
assert.equal(
  vm.runInContext(`customerAddressCopyText({ client:'No Phone', address:'Madrid, Spain', email:'hello@example.com' })`, context),
  'No Phone\nMadrid, Spain\n邮箱：hello@example.com'
);
assert.equal(
  vm.runInContext(`customerAddressCopyText({ client:'No Email', address:'Toronto, Canada', phone:'+1 416 555 0100', paymentEmail:'private@example.com' })`, context),
  'No Email\nToronto, Canada\n电话：+1 416 555 0100'
);
assert.equal(vm.runInContext(`customerAddressCopyText({ client:'Missing Address', phone:'+1 416 555 0100' })`, context), '');

assert.match(html, /window\.flushPendingSave\s*=\s*flushPendingSave/);
assert.equal(packageVersion, `${releaseVersion}.0`);
assert.ok(html.includes(`>V${releaseVersion}</div>`));
assert.match(html, /X-Trade-Token/);
assert.match(html, /baseRevision/);
assert.doesNotMatch(html, /const macAppPort\s*=/);
assert.doesNotMatch(html, /rawModel\s*===\s*['"]glm-5\.1['"]/);
assert.equal((html.match(/defaultOrderType:\s*'全款订单'/g) || []).length, 1);
assert.match(html, /await saveMacAiSettings\(testSettings\)/);
assert.doesNotMatch(html, /glm-4\.7-flashx/);
assert.doesNotMatch(serverSource, /glm-4\.7-flashx/);
assert.match(html, /data-copy-customer-address/);
assert.match(html, /客户地址、电话和邮箱已复制/);
assert.match(html, /客户地址未填写/);
assert.match(html, /const wasShippedWithoutStatus = stage === 'shipment'/);
assert.match(html, /logisticsStatus: primaryShipment\?\.status \|\| \(wasShippedWithoutStatus \? '已发货'/);
assert.match(html, /macPersistedStateJson\s*=\s*JSON\.stringify\(state\)/);
assert.doesNotMatch(html, /loaded\.rawState|rawState\s*,\s*revision/);
assert.doesNotMatch(html, /<span class="order-num">\$\{o\.num\}<\/span>/);
assert.doesNotMatch(html, /<span>\$\{o\.country \|\| '未填写国家'\}<\/span>/);

context.state = {orders:[], customers:{}};
const exampleHeader = 'buyer.sample@example.com\nEliza M\n';
const examplePhone = '\n2025550129';
for (const [input, address] of [
  ['123 Sample Turnpike Suite 207\nPoughkeepsie New York 12603', '123 Sample Turnpike Suite 207, Poughkeepsie New York 12603'],
  ['123 Sample Turnpike\nSuite 207\nPoughkeepsie New York 12603', '123 Sample Turnpike, Suite 207, Poughkeepsie New York 12603'],
  ['123 Sample Tpke\nSte. #207\nPoughkeepsie New York 12603', '123 Sample Tpke, Ste. #207, Poughkeepsie New York 12603'],
  ['123 Sample Turnpike\nPoughkeepsie New York 12603\nSuite 207', '123 Sample Turnpike, Poughkeepsie New York 12603, Suite 207'],
  ['Suite207\n123 Sample Turnpike\nPoughkeepsie New York 12603', 'Suite207, 123 Sample Turnpike, Poughkeepsie New York 12603']
]) {
  const text = exampleHeader + input + examplePhone;
  const fields = context.analyzeCustomerPasteText(text).extracted;
  assert.equal(fields.address,address,`Address lost: ${input}`);
  assert.equal(fields.name,'Eliza M');
  assert.equal(fields.email,'buyer.sample@example.com');
  assert.equal(fields.phone,'2025550129');
  assert.equal(fields.country,'🇺🇸 美国 United States');
  assert.equal(context.findAmountInText(text),'','Unit number must not become money');
}
for (const unit of ['Suite 207', 'suite207', 'Suite #207', 'Suite: 207', 'Ste. 207', 'Ste. #207', 'Suite A-207']) {
  assert.equal(context.findCustomerAddressInText(unit),unit,`Standalone unit lost: ${unit}`);
  assert.equal(context.findAmountInText(unit),'');
}
assert.equal(context.isAddressUnitLine('Suitecase'),false);
assert.equal(context.isAddressUnitLine('Unit price 207'),false);
assert.equal(context.findAmountInText('Suite 207\n阿里408'),408);
assert.equal(context.findCustomerAddressInText('Eliza M 123 Sample Turnpike Suite 207 Poughkeepsie New York 12603'),
  '123 Sample Turnpike Suite 207 Poughkeepsie New York 12603');

// Names that merely contain address words (rd, ave, lane, unit) are still names
for (const name of ['Jordan Example', 'Dave Sample', 'Elaine Sample', 'Richard Ford', 'Trinity Sample']) {
  assert.equal(context.looksLikeAddressText(name), false, `Name read as address: ${name}`);
  assert.equal(context.cleanContactValue(name), name);
}
for (const address of ['27 Sample Crescent Floor 2', 'Sample Rd.', 'Unit 1208', '18 Example Avenue']) {
  assert.equal(context.looksLikeAddressText(address), true, `Address missed: ${address}`);
}

// Local (offline) customer recognition against 30 realistic pastes; each field is checked like a reviewer would.
{
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'customer-recognition-cases.json'), 'utf8'));
  const low = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const lastDigits = value => String(value || '').replace(/\(0\)/g, '').replace(/\D/g, '').slice(-9);
  const list = (fields, many, one) => (fields[many]?.length ? fields[many] : String(fields[one] || '').split(/\s*;\s*/)).filter(Boolean);
  const sameSet = (actual, expected, eq) => actual.length === expected.length && expected.every(item => actual.some(value => eq(value, item)));
  const failures = [];
  for (const item of cases) {
    const fields = context.analyzeCustomerPasteText(item.text).extracted;
    const errors = [];
    if (!item.name.some(name => low(name) === low(fields.name))) errors.push(`name=${fields.name}`);
    if (!sameSet(list(fields, 'contacts', 'contact'), item.contacts, (a, b) => low(a) === low(b))) errors.push(`contacts=${list(fields, 'contacts', 'contact')}`);
    if (!sameSet(list(fields, 'phones', 'phone'), item.phones, (a, b) => lastDigits(a) === lastDigits(b))) errors.push(`phones=${list(fields, 'phones', 'phone')}`);
    if (!sameSet(list(fields, 'emails', 'email'), item.emails, (a, b) => low(a) === low(b))) errors.push(`emails=${list(fields, 'emails', 'email')}`);
    const addresses = list(fields, 'addresses', 'address');
    const matches = tokens => addresses.findIndex(address => tokens.every(token => low(address).includes(low(token))));
    const allowed = [...item.addresses, ...(item.optionalAddresses || [])];
    if (matches(item.addresses[0]) !== 0 || !item.addresses.every(tokens => matches(tokens) >= 0)
      || addresses.some(address => !allowed.some(tokens => tokens.every(token => low(address).includes(low(token)))))
      || [...(item.noAddressText || []), ...item.contacts].some(text => addresses.some(address => low(address).includes(low(text))))) errors.push(`addresses=${addresses.join(' || ')}`);
    const expectedCountry = item.country && context.countryDefs.find(country => country.includes(item.country));
    if (expectedCountry ? fields.country !== expectedCountry : Boolean(item.country) && fields.country) errors.push(`country=${fields.country}`);
    if ((fields.paymentMethod || '') !== (item.paymentMethod || '')) errors.push(`paymentMethod=${fields.paymentMethod}`);
    if (low(fields.paymentEmail) !== low(item.paymentEmail)) errors.push(`paymentEmail=${fields.paymentEmail}`);
    if ((item.forbidden || []).some(text => JSON.stringify(fields).toLowerCase().includes(text.toLowerCase()))) errors.push('seller or injected data leaked');
    if (errors.length) failures.push(`${item.id}: ${errors.join('; ')}`);
  }
  assert.deepEqual(failures, [], `Local customer recognition regressions:\n${failures.join('\n')}`);
}

console.log('Order recognition tests passed.');
