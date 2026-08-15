/**
 * Trip Treasurer, backend.
 * Data lives in a Google Sheet this script creates automatically on first run.
 * You do not need to make the Sheet yourself.
 */

var CONFIG = {
  eventName: 'Your Trip Name',
  eventDates: '1 to 3 Jan 2027',
  currency: '$',
  perPerson: 100,
  payName: 'Your Name',
  bank: 'Your Bank',
  account: 'Your account number',
  qrImageUrl: '',              // optional: a hosted image URL of your payment QR. Leave blank to show account details only.
  deadlineDate: '2027-01-01',  // YYYY-MM-DD, when payments are due
  extrasLabel: 'Day guests, not staying over',
  extrasDeadlineDate: '2026-12-20',
  treasurerPin: '0000'         // <-- CHANGE this to your own secret number, then re-deploy
};

// Edit, rename, or add groups here. Any number of groups works.
var GROUPS = [
  { key: 'a', label: 'Group A', color: 'var(--blue)' },
  { key: 'b', label: 'Group B', color: 'var(--leaf)' },
  { key: 'c', label: 'Group C', color: 'var(--orange)' }
];

var EXTRA_PRICES = { breakfast: 10, lunch: 15, dinner: 15, facilities: 5 };

function doGet(){
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Trip Payments')
    .addMetaTag('viewport','width=device-width, initial-scale=1');
}

function getBook_(){
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  var ss = null;
  if(id){ try{ ss = SpreadsheetApp.openById(id); }catch(e){ ss = null; } }
  if(!ss){
    ss = SpreadsheetApp.create('Trip Treasurer (data)');
    props.setProperty('SHEET_ID', ss.getId());
    seed_(ss);
  }
  return ss;
}

function seed_(ss){
  var sh = ss.getSheets()[0];
  sh.setName('People');
  sh.getRange(1,1,1,9).setValues([['id','name','group','freeGuests','owed','paid','lastBy','updatedAt','payingFor']]);
  var ex = ss.insertSheet('Extras');
  ex.getRange(1,1,1,7).setValues([['id','name','breakfast','lunch','dinner','facilities','paid']]);
  var log = ss.insertSheet('Log');
  log.getRange(1,1,1,6).setValues([['when','payer','coveringNames','amount','type','note']]);
  // Starts empty on purpose. Add real people from inside the app once treasurer mode is unlocked.
}

function state_(ss){
  ss = ss || getBook_();
  var sh = ss.getSheetByName('People');
  var v = sh.getDataRange().getValues(); v.shift();
  var people = v.filter(function(r){ return r[0]; }).map(function(r){
    return {id:r[0], name:r[1], group:r[2], freeGuests:Number(r[3])||0, owed:Number(r[4])||0,
            paid:Number(r[5])||0, lastBy:r[6]||'', updatedAt:r[7]?String(r[7]):'', payingFor:r[8]||''};
  });
  var exSh = ss.getSheetByName('Extras');
  var ev = exSh.getDataRange().getValues(); ev.shift();
  var extras = ev.filter(function(r){ return r[0]; }).map(function(r){
    return {id:r[0], name:r[1], breakfast:!!r[2], lunch:!!r[3], dinner:!!r[4], facilities:!!r[5], paid:Number(r[6])||0};
  });
  return {config:CONFIG, groups:GROUPS, extraPrices:EXTRA_PRICES, people:people, extras:extras};
}

function getState(){ return state_(); }

function logRow_(ss, arr){ ss.getSheetByName('Log').appendRow(arr); }

function checkPin_(pin){ if(String(pin) !== String(CONFIG.treasurerPin)) throw new Error('Wrong treasurer PIN'); }

/** A person records a payment. Distributes the amount across the people it covers. */
function recordPayment(p){
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    var ss = getBook_(); var sh = ss.getSheetByName('People');
    var data = sh.getDataRange().getValues();
    var rowOf = {}; for(var i=1;i<data.length;i++){ rowOf[data[i][0]] = i; }
    var amount = Math.max(0, Number(p.amount)||0);
    var covered = (p.coveredIds||[]).filter(function(id){ return rowOf[id]!=null; });
    var names = [];
    var left = amount;
    for(var c=0; c<covered.length && left>0; c++){
      var ri = rowOf[covered[c]];
      var owed = Number(data[ri][4])||0, paid = Number(data[ri][5])||0;
      var room = Math.max(0, owed - paid);
      var add = Math.min(room, left);
      data[ri][5] = paid + add; left -= add;
      data[ri][6] = p.payer||''; data[ri][7] = new Date(); data[ri][8] = p.payer||'';
      names.push(data[ri][1]);
    }
    // any leftover (overpayment) lands on the first covered person so totals stay honest
    if(left > 0 && covered.length){ var r0 = rowOf[covered[0]]; data[r0][5] = Number(data[r0][5]) + left; data[r0][7] = new Date(); left = 0; }
    sh.getRange(1,1,data.length,data[0].length).setValues(data);
    logRow_(ss, [new Date(), p.payer||'', names.join(', '), amount, 'stay', p.note||'']);
    return state_(ss);
  } finally { lock.releaseLock(); }
}

/** Add or update a day-guest entry. Open to everyone. */
function saveExtras(c){
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    var ss = getBook_(); var sh = ss.getSheetByName('Extras');
    var data = sh.getDataRange().getValues();
    var rowOf = {}; for(var i=1;i<data.length;i++){ rowOf[data[i][0]] = i; }
    if(c.id && rowOf[c.id]!=null){
      var ri = rowOf[c.id];
      if(c.name!=null) data[ri][1] = c.name;
      if(c.meals){ data[ri][2]=!!c.meals.breakfast; data[ri][3]=!!c.meals.lunch; data[ri][4]=!!c.meals.dinner; data[ri][5]=!!c.meals.facilities; }
      if(c.paid!=null) data[ri][6] = Math.max(0, Number(c.paid)||0);
      sh.getRange(1,1,data.length,data[0].length).setValues(data);
    } else {
      var id = Utilities.getUuid().slice(0,8);
      var m = c.meals||{};
      sh.appendRow([id, c.name||'New person', !!m.breakfast, !!m.lunch, !!m.dinner, !!m.facilities, Math.max(0, Number(c.paid)||0)]);
    }
    return state_(ss);
  } finally { lock.releaseLock(); }
}

function deleteExtras(o){
  checkPin_(o.pin);
  var ss = getBook_(); var sh = ss.getSheetByName('Extras');
  var data = sh.getDataRange().getValues();
  for(var i=data.length-1;i>=1;i--){ if(data[i][0]===o.id){ sh.deleteRow(i+1); break; } }
  return state_(ss);
}

/** Treasurer only: edit a person's details. */
function editPerson(o){
  checkPin_(o.pin);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    var ss = getBook_(); var sh = ss.getSheetByName('People');
    var data = sh.getDataRange().getValues();
    for(var i=1;i<data.length;i++){ if(data[i][0]===o.id){
      if(o.name!=null) data[i][1] = o.name;
      if(o.group!=null) data[i][2] = o.group;
      if(o.freeGuests!=null) data[i][3] = Math.max(0, parseInt(o.freeGuests,10)||0);
      if(o.owed!=null) data[i][4] = Math.max(0, Number(o.owed)||0);
      if(o.paid!=null) data[i][5] = Math.max(0, Number(o.paid)||0);
      data[i][7] = new Date();
      sh.getRange(i+1,1,1,data[0].length).setValues([data[i]]);
      break;
    }}
    return state_(ss);
  } finally { lock.releaseLock(); }
}

function addPerson(o){
  checkPin_(o.pin);
  var ss = getBook_(); var sh = ss.getSheetByName('People');
  var keys = GROUPS.map(function(g){ return g.key; });
  var group = keys.indexOf(o.group)>=0 ? o.group : keys[0];
  sh.appendRow([Utilities.getUuid().slice(0,8), o.name||'New', group, 0, CONFIG.perPerson, 0, '', new Date(), '']);
  return state_(getBook_());
}

function removePerson(o){
  checkPin_(o.pin);
  var ss = getBook_(); var sh = ss.getSheetByName('People');
  var data = sh.getDataRange().getValues();
  for(var i=data.length-1;i>=1;i--){ if(data[i][0]===o.id){ sh.deleteRow(i+1); break; } }
  return state_(ss);
}
