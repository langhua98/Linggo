// ═══════════════════════════════════════════
//  INDEXED DB — book cache
// ═══════════════════════════════════════════
const IDB_NAME = 'ReadEN', IDB_VER = 1, IDB_STORE = 'books';
function openIDB(){
  return new Promise((res,rej)=>{
    const r = indexedDB.open(IDB_NAME, IDB_VER);
    r.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE,{keyPath:'url'});
    r.onsuccess = e => res(e.target.result);
    r.onerror   = ()=> rej(r.error);
  });
}
async function idbSave(url, text){
  const db = await openIDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put({url, text, ts:Date.now()});
    tx.oncomplete = res; tx.onerror = ()=>rej(tx.error);
  });
}
async function idbGet(url){
  const db = await openIDB();
  return new Promise((res,rej)=>{
    const tx  = db.transaction(IDB_STORE,'readonly');
    const req = tx.objectStore(IDB_STORE).get(url);
    req.onsuccess = ()=> res(req.result?.text||null);
    req.onerror   = ()=> rej(req.error);
  });
}
async function idbHas(url){
  const db = await openIDB();
  return new Promise((res,rej)=>{
    const tx  = db.transaction(IDB_STORE,'readonly');
    const req = tx.objectStore(IDB_STORE).count(url);
    req.onsuccess = ()=> res(req.result > 0);
    req.onerror   = ()=> rej(req.error);
  });
}

// ═══════════════════════════════════════════
//  BOOK DATA
// ═══════════════════════════════════════════
const BOOKS = [
  // ── 🟢 BEGINNER ──
  [
    {t:"Alice's Adventures in Wonderland",a:"Lewis Carroll",y:1865,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/11/11-0.txt",mark:"CHAPTER I.",
     isbn:"9780141439761",pal:["#7B6CF6","#B794F4"]},
    {t:"The Wonderful Wizard of Oz",a:"L. Frank Baum",y:1900,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/55/55-0.txt",mark:"Chapter I.",
     isbn:"9780147514011",pal:["#48BB78","#F6E05E"]},
    {t:"The Adventures of Tom Sawyer",a:"Mark Twain",y:1876,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/74/74-0.txt",mark:"CHAPTER I",
     isbn:"9780143039600",pal:["#F6AD55","#FC8181"]},
    {t:"The Jungle Book",a:"Rudyard Kipling",y:1894,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/236/236-0.txt",mark:"Mowgli's Brothers",
     isbn:"9780142437889",pal:["#68D391","#276749"]},
    {t:"Adventures of Huckleberry Finn",a:"Mark Twain",y:1884,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/76/76-0.txt",mark:"CHAPTER I.",
     isbn:"9780486280615",pal:["#63B3ED","#2B6CB0"]},
    {t:"The Secret Garden",a:"Frances H. Burnett",y:1911,cat:["classic"],
     url:"https://www.gutenberg.org/files/113/113-0.txt",mark:"There is no one left",
     isbn:"9780142437056",pal:["#FC8181","#9AE6B4"]},
    {t:"Black Beauty",a:"Anna Sewell",y:1877,cat:["classic"],
     url:"https://www.gutenberg.org/files/271/271-0.txt",mark:"My Early Home",
     isbn:"9780141321486",pal:["#2D3748","#718096"]},
    {t:"O. Henry Short Stories",a:"O. Henry",y:1906,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/2776/2776.txt",mark:"THE GIFT OF THE MAGI",
     isbn:"9780486270616",pal:["#ECC94B","#C05621"]},
    {t:"Peter Pan",a:"J. M. Barrie",y:1911,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/16/16-0.txt",mark:"Chapter 1",
     isbn:"9780141321134",pal:["#76E4F7","#0987A0"]},
    {t:"The Railway Children",a:"E. Nesbit",y:1906,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/1874/1874-0.txt",mark:"The beginning of things",
     isbn:"9780140367652",pal:["#F687B3","#B83280"]},
    {t:"The Wind in the Willows",a:"Kenneth Grahame",y:1908,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/289/289-0.txt",mark:"The Mole had been working",
     isbn:"9780141321066",pal:["#48BB78","#F6E05E"]},
    {t:"Little Women",a:"Louisa May Alcott",y:1868,cat:["classic"],
     url:"https://www.gutenberg.org/files/514/514-0.txt",mark:"Christmas won't be",
     isbn:"9780140390698",pal:["#FC8181","#F6AD55"]},
    {t:"Anne of Green Gables",a:"L. M. Montgomery",y:1908,cat:["classic"],
     url:"https://www.gutenberg.org/files/45/45-0.txt",mark:"Mrs. Rachel Lynde lived",
     isbn:"9780141321042",pal:["#F687B3","#276749"]},
    {t:"The Call of the Wild",a:"Jack London",y:1903,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/215/215-0.txt",mark:"Buck did not read",
     isbn:"9780142437674",pal:["#C05621","#744210"]},
    {t:"White Fang",a:"Jack London",y:1906,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/910/910-0.txt",mark:"Dark spruce forest",
     isbn:"9780142437629",pal:["#E2E8F0","#2B6CB0"]},
    {t:"Pollyanna",a:"Eleanor H. Porter",y:1913,cat:["classic"],
     url:"https://www.gutenberg.org/files/1450/1450-0.txt",mark:"Miss Polly Harrington",
     isbn:"9780141439327",pal:["#F6E05E","#FC8181"]},
    {t:"Heidi",a:"Johanna Spyri",y:1881,cat:["classic"],
     url:"https://www.gutenberg.org/files/1448/1448-0.txt",mark:"The sun had just",
     isbn:"9780141321257",pal:["#9AE6B4","#276749"]},
    {t:"A Little Princess",a:"Frances H. Burnett",y:1905,cat:["classic"],
     url:"https://www.gutenberg.org/files/146/146-0.txt",mark:"Once on a time, a great many years ago",
     isbn:"9780141321059",pal:["#F687B3","#9B2C2C"]},
    {t:"The Happy Prince and Other Tales",a:"Oscar Wilde",y:1888,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/902/902-0.txt",mark:"High above the city",
     isbn:"9780140621655",pal:["#ECC94B","#B7791F"]},
    {t:"Just So Stories",a:"Rudyard Kipling",y:1902,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/2781/2781-0.txt",mark:"In the High and Far-Off Times",
     isbn:"9780142301067",pal:["#C05621","#9AE6B4"]},
    {t:"Five Children and It",a:"E. Nesbit",y:1902,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/170/170-0.txt",mark:"The house was three miles",
     isbn:"9780141321516",pal:["#FBD38D","#276749"]},
    {t:"The Merry Adventures of Robin Hood",a:"Howard Pyle",y:1883,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/964/964-0.txt",mark:"In merry England in the time",
     isbn:"9780486298306",pal:["#276749","#9B2C2C"]},
    {t:"Grimm's Fairy Tales",a:"Brothers Grimm",y:1812,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/2591/2591-0.txt",mark:"THE GOLDEN BIRD",
     isbn:"9780140300697",pal:["#9F7AEA","#ECC94B"]},
    {t:"Andersen's Fairy Tales",a:"H. C. Andersen",y:1835,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/1597/1597-0.txt",mark:"THERE came a soldier",
     isbn:"9780140449259",pal:["#4299E1","#FBD38D"]},
    {t:"Rebecca of Sunnybrook Farm",a:"Kate Douglas Wiggin",y:1903,cat:["classic"],
     url:"https://www.gutenberg.org/files/450/450-0.txt",mark:"The stage coach that ran",
     isbn:"9780448060378",pal:["#F687B3","#F6AD55"]},
    {t:"The Story of Doctor Dolittle",a:"Hugh Lofting",y:1920,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/501/501-0.txt",mark:"PUDDLEBY",
     isbn:"9780440483830",pal:["#4299E1","#9AE6B4"]},
    {t:"Swiss Family Robinson",a:"Johann D. Wyss",y:1812,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/3836/3836-0.txt",mark:"For many days we had been",
     isbn:"9780141321271",pal:["#276749","#ECC94B"]},
    {t:"Daddy-Long-Legs",a:"Jean Webster",y:1912,cat:["classic"],
     url:"https://www.gutenberg.org/files/3344/3344-0.txt",mark:"The first Wednesday",
     isbn:"9780141321417",pal:["#F6AD55","#9B2C2C"]},
    {t:"The Enchanted Castle",a:"E. Nesbit",y:1907,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/1380/1380-0.txt",mark:"It was one of those",
     isbn:"9780141321097",pal:["#9F7AEA","#F6E05E"]},
    {t:"Beautiful Joe",a:"Marshall Saunders",y:1893,cat:["classic"],
     url:"https://www.gutenberg.org/files/4960/4960-0.txt",mark:"My name is Beautiful Joe",
     isbn:"9781552638668",pal:["#C05621","#2D3748"]},
    {t:"Aesop's Fables",a:"Aesop",y:-600,cat:["classic","short"],
     url:"https://www.gutenberg.org/files/21/21.txt",mark:"THE WOLF AND THE LAMB",
     isbn:"9780140446494",pal:["#ECC94B","#C05621"]},
    {t:"The Water-Babies",a:"Charles Kingsley",y:1863,cat:["classic","fantasy"],
     url:"https://www.gutenberg.org/files/1018/1018-0.txt",mark:"Once upon a time there was a little chimney",
     isbn:"9780141321127",pal:["#4299E1","#9AE6B4"]},
  ],
  // ── 🟡 INTERMEDIATE ──
  [
    {t:"A Study in Scarlet",a:"Arthur Conan Doyle",y:1887,cat:["mystery"],
     url:"https://www.gutenberg.org/files/244/244-0.txt",mark:"PART I",
     isbn:"9780140439083",pal:["#2D3748","#E53E3E"]},
    {t:"The Adventures of Sherlock Holmes",a:"Arthur Conan Doyle",y:1892,cat:["mystery"],
     url:"https://www.gutenberg.org/files/1661/1661-0.txt",mark:"ADVENTURE I.",
     isbn:"9780140437713",pal:["#1A202C","#90CDF4"]},
    {t:"Pride and Prejudice",a:"Jane Austen",y:1813,cat:["classic"],
     url:"https://www.gutenberg.org/files/1342/1342-0.txt",mark:"Chapter 1",
     isbn:"9780141439518",pal:["#FEB2B2","#9B2C2C"]},
    {t:"The Picture of Dorian Gray",a:"Oscar Wilde",y:1890,cat:["classic","horror"],
     url:"https://www.gutenberg.org/files/174/174-0.txt",mark:"The studio was filled",
     isbn:"9780141439570",pal:["#9F7AEA","#553C9A"]},
    {t:"The Great Gatsby",a:"F. Scott Fitzgerald",y:1925,cat:["classic"],
     url:"https://www.gutenberg.org/files/64317/64317-0.txt",mark:"In my younger",
     isbn:"9780743273565",pal:["#F6E05E","#744210"]},
    {t:"Treasure Island",a:"Robert Louis Stevenson",y:1883,cat:["adventure"],
     url:"https://www.gutenberg.org/files/120/120-0.txt",mark:"PART ONE",
     isbn:"9780141321073",pal:["#F6AD55","#2D3748"]},
    {t:"The Time Machine",a:"H. G. Wells",y:1895,cat:["scifi"],
     url:"https://www.gutenberg.org/files/35/35-0.txt",mark:"Introduction",
     isbn:"9780141439976",pal:["#4299E1","#1A202C"]},
    {t:"Strange Case of Dr Jekyll and Mr Hyde",a:"R. L. Stevenson",y:1886,cat:["horror","classic"],
     url:"https://www.gutenberg.org/files/43/43-0.txt",mark:"Story of the Door",
     isbn:"9780141439648",pal:["#718096","#1A202C"]},
    {t:"Dracula",a:"Bram Stoker",y:1897,cat:["horror"],
     url:"https://www.gutenberg.org/files/345/345-0.txt",mark:"3 May.",
     isbn:"9780141439846",pal:["#C53030","#1A202C"]},
    {t:"Frankenstein",a:"Mary Shelley",y:1818,cat:["scifi","horror"],
     url:"https://www.gutenberg.org/files/84/84-0.txt",mark:"Letter 1",
     isbn:"9780141439471",pal:["#2C5282","#E2E8F0"]},
    {t:"Around the World in 80 Days",a:"Jules Verne",y:1872,cat:["adventure"],
     url:"https://www.gutenberg.org/files/103/103-0.txt",mark:"IN WHICH",
     isbn:"9780140449068",pal:["#F6AD55","#276749"]},
    {t:"Sense and Sensibility",a:"Jane Austen",y:1811,cat:["classic"],
     url:"https://www.gutenberg.org/files/161/161-0.txt",mark:"Chapter 1",
     isbn:"9780141439662",pal:["#FEB2B2","#744210"]},
    {t:"Emma",a:"Jane Austen",y:1815,cat:["classic"],
     url:"https://www.gutenberg.org/files/158/158-0.txt",mark:"Chapter I",
     isbn:"9780141439587",pal:["#9AE6B4","#276749"]},
    {t:"The Sign of Four",a:"Arthur Conan Doyle",y:1890,cat:["mystery"],
     url:"https://www.gutenberg.org/files/2097/2097-0.txt",mark:"Chapter 1",
     isbn:"9780192835192",pal:["#ECC94B","#1A202C"]},
    {t:"The Count of Monte Cristo",a:"Alexandre Dumas",y:1844,cat:["adventure","classic"],
     url:"https://www.gutenberg.org/files/1184/1184-0.txt",mark:"Chapter 1",
     isbn:"9780140449266",pal:["#2D3748","#ECC94B"]},
    {t:"The Three Musketeers",a:"Alexandre Dumas",y:1844,cat:["adventure","classic"],
     url:"https://www.gutenberg.org/files/1257/1257-0.txt",mark:"Chapter I",
     isbn:"9780140440379",pal:["#C05621","#1A202C"]},
    {t:"The War of the Worlds",a:"H. G. Wells",y:1898,cat:["scifi"],
     url:"https://www.gutenberg.org/files/36/36-0.txt",mark:"No one would have believed",
     isbn:"9780141441030",pal:["#C53030","#1A202C"]},
    {t:"Twenty Thousand Leagues Under the Sea",a:"Jules Verne",y:1870,cat:["adventure","scifi"],
     url:"https://www.gutenberg.org/files/164/164-0.txt",mark:"The year 1866",
     isbn:"9780140440577",pal:["#2C5282","#81E6D9"]},
    {t:"The Hound of the Baskervilles",a:"Arthur Conan Doyle",y:1902,cat:["mystery"],
     url:"https://www.gutenberg.org/files/2852/2852-0.txt",mark:"Mr. Sherlock Holmes",
     isbn:"9780192836878",pal:["#4A5568","#A0AEC0"]},
    {t:"Robinson Crusoe",a:"Daniel Defoe",y:1719,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/521/521-0.txt",mark:"I was born in the Year",
     isbn:"9780141439822",pal:["#F6AD55","#276749"]},
    {t:"Oliver Twist",a:"Charles Dickens",y:1837,cat:["classic"],
     url:"https://www.gutenberg.org/files/730/730-0.txt",mark:"Among other public buildings",
     isbn:"9780141439747",pal:["#718096","#2D3748"]},
    {t:"The Invisible Man",a:"H. G. Wells",y:1897,cat:["scifi","horror"],
     url:"https://www.gutenberg.org/files/5230/5230-0.txt",mark:"The stranger came early",
     isbn:"9780141441030",pal:["#CBD5E0","#2D3748"]},
    {t:"Kidnapped",a:"Robert Louis Stevenson",y:1886,cat:["adventure","classic"],
     url:"https://www.gutenberg.org/files/421/421-0.txt",mark:"I will begin",
     isbn:"9780141321073",pal:["#4299E1","#2C5282"]},
    {t:"Persuasion",a:"Jane Austen",y:1817,cat:["classic"],
     url:"https://www.gutenberg.org/files/105/105-0.txt",mark:"Sir Walter Elliot",
     isbn:"9780141439686",pal:["#B2F5EA","#285E61"]},
    {t:"The Red Badge of Courage",a:"Stephen Crane",y:1895,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/73/73-0.txt",mark:"The cold passed reluctantly",
     isbn:"9780141441481",pal:["#9B2C2C","#C05621"]},
    {t:"Uncle Tom's Cabin",a:"Harriet Beecher Stowe",y:1852,cat:["classic"],
     url:"https://www.gutenberg.org/files/203/203-0.txt",mark:"Late in the afternoon",
     isbn:"9780143106289",pal:["#2D3748","#C05621"]},
    {t:"Northanger Abbey",a:"Jane Austen",y:1817,cat:["classic"],
     url:"https://www.gutenberg.org/files/121/121-0.txt",mark:"No one who had ever seen Catherine",
     isbn:"9780141439792",pal:["#4299E1","#F687B3"]},
    {t:"Mansfield Park",a:"Jane Austen",y:1814,cat:["classic"],
     url:"https://www.gutenberg.org/files/141/141-0.txt",mark:"About thirty years ago",
     isbn:"9780141439808",pal:["#276749","#F6AD55"]},
    {t:"The Last of the Mohicans",a:"James Fenimore Cooper",y:1826,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/27/27-0.txt",mark:"It was a feature peculiar",
     isbn:"9780142437247",pal:["#276749","#C05621"]},
    {t:"Ivanhoe",a:"Sir Walter Scott",y:1820,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/82/82-0.txt",mark:"In that pleasant district",
     isbn:"9780141439648",pal:["#C05621","#2D3748"]},
    {t:"A Room with a View",a:"E. M. Forster",y:1908,cat:["classic"],
     url:"https://www.gutenberg.org/files/2641/2641-0.txt",mark:"The Signora had no business",
     isbn:"9780141183299",pal:["#ECC94B","#276749"]},
    {t:"Kim",a:"Rudyard Kipling",y:1901,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/2226/2226-0.txt",mark:"He sat, in defiance",
     isbn:"9780142437728",pal:["#C05621","#ECC94B"]},
    {t:"Tess of the d'Urbervilles",a:"Thomas Hardy",y:1891,cat:["classic"],
     url:"https://www.gutenberg.org/files/110/110-0.txt",mark:"On an evening in the latter part of May",
     isbn:"9780141439594",pal:["#9B2C2C","#276749"]},
  ],
  // ── 🔴 ADVANCED ──
  [
    {t:"Moby-Dick",a:"Herman Melville",y:1851,cat:["classic"],
     url:"https://www.gutenberg.org/files/2701/2701-0.txt",mark:"Call me Ishmael",
     isbn:"9780142437247",pal:["#2B6CB0","#1A202C"]},
    {t:"Jane Eyre",a:"Charlotte Brontë",y:1847,cat:["classic"],
     url:"https://www.gutenberg.org/files/1260/1260-0.txt",mark:"There was no possibility",
     isbn:"9780141441146",pal:["#C05621","#744210"]},
    {t:"A Tale of Two Cities",a:"Charles Dickens",y:1859,cat:["classic"],
     url:"https://www.gutenberg.org/files/98/98-0.txt",mark:"It was the best of times",
     isbn:"9780141439600",pal:["#C53030","#1A202C"]},
    {t:"Wuthering Heights",a:"Emily Brontë",y:1847,cat:["classic","horror"],
     url:"https://www.gutenberg.org/files/768/768-0.txt",mark:"1801",
     isbn:"9780141439556",pal:["#4A5568","#E2E8F0"]},
    {t:"Great Expectations",a:"Charles Dickens",y:1861,cat:["classic"],
     url:"https://www.gutenberg.org/files/1400/1400-0.txt",mark:"My father's family name",
     isbn:"9780141439563",pal:["#276749","#F6E05E"]},
    {t:"Walden",a:"Henry David Thoreau",y:1854,cat:["classic"],
     url:"https://www.gutenberg.org/files/205/205-0.txt",mark:"ECONOMY",
     isbn:"9780691096124",pal:["#276749","#C6F6D5"]},
    {t:"The Metamorphosis",a:"Franz Kafka",y:1915,cat:["classic","scifi"],
     url:"https://www.gutenberg.org/files/5200/5200-0.txt",mark:"One morning",
     isbn:"9780141184128",pal:["#718096","#2D3748"]},
    {t:"Crime and Punishment",a:"Fyodor Dostoevsky",y:1866,cat:["classic"],
     url:"https://www.gutenberg.org/files/2554/2554-0.txt",mark:"PART I",
     isbn:"9780140449136",pal:["#C53030","#744210"]},
    {t:"Middlemarch",a:"George Eliot",y:1871,cat:["classic"],
     url:"https://www.gutenberg.org/files/145/145-0.txt",mark:"Miss Brooke",
     isbn:"9780141439549",pal:["#B7791F","#FEFCBF"]},
    {t:"The Brothers Karamazov",a:"Fyodor Dostoevsky",y:1880,cat:["classic"],
     url:"https://www.gutenberg.org/files/28054/28054-0.txt",mark:"PART I",
     isbn:"9780374528379",pal:["#2C5282","#ECC94B"]},
    {t:"Les Misérables",a:"Victor Hugo",y:1862,cat:["classic"],
     url:"https://www.gutenberg.org/files/135/135-0.txt",mark:"M. Myriel",
     isbn:"9780140444308",pal:["#C53030","#2D3748"]},
    {t:"Anna Karenina",a:"Leo Tolstoy",y:1877,cat:["classic"],
     url:"https://www.gutenberg.org/files/1399/1399-0.txt",mark:"All happy families",
     isbn:"9780143035008",pal:["#B7791F","#1A202C"]},
    {t:"War and Peace",a:"Leo Tolstoy",y:1869,cat:["classic"],
     url:"https://www.gutenberg.org/files/2600/2600-0.txt",mark:"Well, Prince",
     isbn:"9780140447934",pal:["#2D3748","#ECC94B"]},
    {t:"David Copperfield",a:"Charles Dickens",y:1850,cat:["classic"],
     url:"https://www.gutenberg.org/files/766/766-0.txt",mark:"Whether I shall turn",
     isbn:"9780141439501",pal:["#744210","#F6AD55"]},
    {t:"Vanity Fair",a:"W. M. Thackeray",y:1848,cat:["classic"],
     url:"https://www.gutenberg.org/files/599/599-0.txt",mark:"While the present century",
     isbn:"9780140434729",pal:["#B7791F","#FC8181"]},
    {t:"Bleak House",a:"Charles Dickens",y:1853,cat:["classic"],
     url:"https://www.gutenberg.org/files/1023/1023-0.txt",mark:"London.",
     isbn:"9780141439723",pal:["#4A5568","#718096"]},
    {t:"Gulliver's Travels",a:"Jonathan Swift",y:1726,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/829/829-0.txt",mark:"My father had a small estate",
     isbn:"9780141439495",pal:["#4299E1","#276749"]},
    {t:"Don Quixote",a:"Miguel de Cervantes",y:1605,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/996/996-0.txt",mark:"In a village of La Mancha",
     isbn:"9780142437230",pal:["#C05621","#ECC94B"]},
    {t:"Heart of Darkness",a:"Joseph Conrad",y:1899,cat:["classic","adventure"],
     url:"https://www.gutenberg.org/files/219/219-0.txt",mark:"The Nellie, a cruising",
     isbn:"9780141441672",pal:["#2D3748","#276749"]},
    {t:"The Turn of the Screw",a:"Henry James",y:1898,cat:["classic","mystery","horror"],
     url:"https://www.gutenberg.org/files/209/209-0.txt",mark:"The story had held us",
     isbn:"9780141441351",pal:["#2D3748","#9F7AEA"]},
    {t:"The Mayor of Casterbridge",a:"Thomas Hardy",y:1886,cat:["classic"],
     url:"https://www.gutenberg.org/files/143/143-0.txt",mark:"One evening of late summer",
     isbn:"9780140430387",pal:["#9B2C2C","#2D3748"]},
    {t:"The Awakening",a:"Kate Chopin",y:1899,cat:["classic"],
     url:"https://www.gutenberg.org/files/160/160-0.txt",mark:"A green and yellow parrot",
     isbn:"9780393979893",pal:["#276749","#4299E1"]},
  ],
];

// ── Local Gutenberg catalog for offline search
// format: [id, title, author, year, [categories], markText]
const CATALOG = [
  // ── Mark Twain
  [74,"The Adventures of Tom Sawyer","Mark Twain",1876,["classic","adventure"],"CHAPTER I"],
  [76,"Adventures of Huckleberry Finn","Mark Twain",1884,["classic","adventure"],"CHAPTER I."],
  [86,"A Connecticut Yankee in King Arthur's Court","Mark Twain",1889,["classic","adventure","fantasy"],"A Word of Explanation"],
  [91,"Pudd'nhead Wilson","Mark Twain",1894,["classic","mystery"],"Chapter 1"],
  [102,"The Prince and the Pauper","Mark Twain",1881,["classic","adventure"],"PART FIRST"],
  [245,"Life on the Mississippi","Mark Twain",1883,["classic","adventure"],"Chapter 1"],
  [1837,"The Innocents Abroad","Mark Twain",1869,["classic","adventure"],"Chapter 1"],
  // ── Arthur Conan Doyle
  [244,"A Study in Scarlet","Arthur Conan Doyle",1887,["mystery"],"PART I"],
  [1661,"The Adventures of Sherlock Holmes","Arthur Conan Doyle",1892,["mystery"],"ADVENTURE I."],
  [2097,"The Sign of Four","Arthur Conan Doyle",1890,["mystery"],"Chapter 1"],
  [834,"The Memoirs of Sherlock Holmes","Arthur Conan Doyle",1893,["mystery"],"Adventure I"],
  [2350,"The Return of Sherlock Holmes","Arthur Conan Doyle",1905,["mystery"],"Adventure I"],
  [2852,"The Hound of the Baskervilles","Arthur Conan Doyle",1902,["mystery"],"Mr. Sherlock Holmes"],
  [108,"The Valley of Fear","Arthur Conan Doyle",1915,["mystery"],"Part I"],
  [1268,"His Last Bow","Arthur Conan Doyle",1917,["mystery"],"Adventure I"],
  // ── Jane Austen
  [1342,"Pride and Prejudice","Jane Austen",1813,["classic"],"Chapter 1"],
  [158,"Emma","Jane Austen",1815,["classic"],"Chapter I"],
  [161,"Sense and Sensibility","Jane Austen",1811,["classic"],"Chapter 1"],
  [105,"Persuasion","Jane Austen",1817,["classic"],"Sir Walter Elliot"],
  [141,"Mansfield Park","Jane Austen",1814,["classic"],"Chapter 1"],
  [121,"Northanger Abbey","Jane Austen",1817,["classic","horror"],"Chapter 1"],
  // ── Charles Dickens
  [730,"Oliver Twist","Charles Dickens",1837,["classic"],"Among other public buildings"],
  [766,"David Copperfield","Charles Dickens",1850,["classic"],"Whether I shall turn"],
  [98,"A Tale of Two Cities","Charles Dickens",1859,["classic"],"It was the best of times"],
  [1400,"Great Expectations","Charles Dickens",1861,["classic"],"My father's family name"],
  [1023,"Bleak House","Charles Dickens",1853,["classic"],"London."],
  [917,"Hard Times","Charles Dickens",1854,["classic"],"CHAPTER I"],
  [700,"The Pickwick Papers","Charles Dickens",1836,["classic"],"Chapter 1"],
  [821,"The Old Curiosity Shop","Charles Dickens",1841,["classic"],"Chapter 1"],
  // ── H. G. Wells
  [35,"The Time Machine","H. G. Wells",1895,["scifi"],"Introduction"],
  [36,"The War of the Worlds","H. G. Wells",1898,["scifi"],"No one would have believed"],
  [159,"The Island of Doctor Moreau","H. G. Wells",1896,["scifi","horror"],"Introduction"],
  [5230,"The Invisible Man","H. G. Wells",1897,["scifi","horror"],"The stranger came early"],
  [718,"When the Sleeper Wakes","H. G. Wells",1899,["scifi"],"Insomnia"],
  // ── Jules Verne
  [164,"Twenty Thousand Leagues Under the Sea","Jules Verne",1870,["adventure","scifi"],"The year 1866"],
  [103,"Around the World in 80 Days","Jules Verne",1872,["adventure"],"IN WHICH"],
  [1537,"The Mysterious Island","Jules Verne",1874,["adventure","scifi"],"Chapter 1"],
  // ── Jack London
  [215,"The Call of the Wild","Jack London",1903,["classic","adventure"],"Buck did not read"],
  [910,"White Fang","Jack London",1906,["classic","adventure"],"Dark spruce forest"],
  [1743,"The Sea-Wolf","Jack London",1904,["adventure"],"Chapter I"],
  [1125,"Martin Eden","Jack London",1909,["classic"],"Chapter One"],
  // ── Brontë Sisters
  [1260,"Jane Eyre","Charlotte Brontë",1847,["classic"],"There was no possibility"],
  [768,"Wuthering Heights","Emily Brontë",1847,["classic","horror"],"1801"],
  [969,"Villette","Charlotte Brontë",1853,["classic"],"Chapter I"],
  [226,"Shirley","Charlotte Brontë",1849,["classic"],"Chapter I"],
  // ── Horror & Gothic
  [345,"Dracula","Bram Stoker",1897,["horror"],"3 May."],
  [84,"Frankenstein","Mary Shelley",1818,["scifi","horror"],"Letter 1"],
  [43,"Strange Case of Dr Jekyll and Mr Hyde","R. L. Stevenson",1886,["classic","horror"],"Story of the Door"],
  [174,"The Picture of Dorian Gray","Oscar Wilde",1890,["classic","horror"],"The studio was filled"],
  [209,"The Turn of the Screw","Henry James",1898,["classic","horror"],"The story had held us"],
  [2005,"The House of the Seven Gables","Nathaniel Hawthorne",1851,["classic","horror"],"Chapter I"],
  // ── Adventure & Travel
  [120,"Treasure Island","R. L. Stevenson",1883,["adventure"],"PART ONE"],
  [421,"Kidnapped","R. L. Stevenson",1886,["adventure","classic"],"I will begin"],
  [521,"Robinson Crusoe","Daniel Defoe",1719,["classic","adventure"],"I was born in the Year"],
  [829,"Gulliver's Travels","Jonathan Swift",1726,["classic","fantasy","adventure"],"CHAPTER I"],
  [160,"The Scarlet Pimpernel","Baroness Orczy",1905,["adventure","classic"],"Chapter 1"],
  // ── Alexandre Dumas
  [1184,"The Count of Monte Cristo","Alexandre Dumas",1844,["adventure","classic"],"Chapter 1"],
  [1257,"The Three Musketeers","Alexandre Dumas",1844,["adventure","classic"],"Chapter I"],
  [10007,"Twenty Years After","Alexandre Dumas",1845,["adventure","classic"],"Chapter 1"],
  // ── Russian Literature
  [2554,"Crime and Punishment","Fyodor Dostoevsky",1866,["classic"],"PART I"],
  [28054,"The Brothers Karamazov","Fyodor Dostoevsky",1880,["classic"],"PART I"],
  [1399,"Anna Karenina","Leo Tolstoy",1877,["classic"],"All happy families"],
  [2600,"War and Peace","Leo Tolstoy",1869,["classic"],"Well, Prince"],
  // ── American Classics
  [25344,"The Scarlet Letter","Nathaniel Hawthorne",1850,["classic"],"THE PRISON-DOOR"],
  [2701,"Moby-Dick","Herman Melville",1851,["classic"],"Call me Ishmael"],
  [64317,"The Great Gatsby","F. Scott Fitzgerald",1925,["classic"],"In my younger"],
  [203,"Uncle Tom's Cabin","Harriet Beecher Stowe",1852,["classic"],"Chapter I"],
  [73,"The Red Badge of Courage","Stephen Crane",1895,["classic","adventure"],"Chapter 1"],
  [432,"The Awakening","Kate Chopin",1899,["classic"],"Chapter I"],
  [205,"Walden","Henry David Thoreau",1854,["classic"],"ECONOMY"],
  [142,"The Autobiography of Benjamin Franklin","Benjamin Franklin",1791,["classic"],"Twyford"],
  // ── Henry James
  [2833,"The Portrait of a Lady","Henry James",1881,["classic"],"Under certain circumstances"],
  [526,"The American","Henry James",1877,["classic"],"Chapter I"],
  // ── Children & Family
  [11,"Alice's Adventures in Wonderland","Lewis Carroll",1865,["classic","fantasy"],"CHAPTER I."],
  [55,"The Wonderful Wizard of Oz","L. Frank Baum",1900,["classic","fantasy"],"Chapter I."],
  [16,"Peter Pan","J. M. Barrie",1911,["classic","fantasy"],"Chapter 1"],
  [113,"The Secret Garden","Frances H. Burnett",1911,["classic"],"There is no one left"],
  [271,"Black Beauty","Anna Sewell",1877,["classic"],"My Early Home"],
  [289,"The Wind in the Willows","Kenneth Grahame",1908,["classic","fantasy"],"The Mole had been working"],
  [236,"The Jungle Book","Rudyard Kipling",1894,["classic","adventure"],"Mowgli's Brothers"],
  [514,"Little Women","Louisa May Alcott",1868,["classic"],"Christmas won't be"],
  [45,"Anne of Green Gables","L. M. Montgomery",1908,["classic"],"Mrs. Rachel Lynde lived"],
  [1450,"Pollyanna","Eleanor H. Porter",1913,["classic"],"Miss Polly Harrington"],
  [1448,"Heidi","Johanna Spyri",1881,["classic"],"The sun had just"],
  [1874,"The Railway Children","E. Nesbit",1906,["classic","adventure"],"The beginning of things"],
  [805,"The Adventures of Pinocchio","Carlo Collodi",1883,["classic","fantasy"],"Chapter 1"],
  [2591,"Grimm's Fairy Tales","Brothers Grimm",1812,["classic","fantasy"],"THE GOLDEN BIRD"],
  [19033,"Andersen's Fairy Tales","Hans Christian Andersen",1835,["classic","fantasy"],"THE TINDER-BOX"],
  [1080,"The Story of My Life","Helen Keller",1903,["classic"],"Chapter I"],
  // ── Short Stories
  [2776,"O. Henry Short Stories","O. Henry",1906,["classic","short"],"THE GIFT OF THE MAGI"],
  // ── Victorian & British
  [145,"Middlemarch","George Eliot",1871,["classic"],"Miss Brooke"],
  [599,"Vanity Fair","W. M. Thackeray",1848,["classic"],"While the present century"],
  [110,"Tess of the d'Urbervilles","Thomas Hardy",1891,["classic"],"Phase the First"],
  // ── French Literature
  [135,"Les Misérables","Victor Hugo",1862,["classic"],"M. Myriel"],
  // ── Drama & Philosophy
  [2542,"A Doll's House","Henrik Ibsen",1879,["classic"],"ACT I"],
  [1220,"The Prince","Niccolò Machiavelli",1532,["classic"],"Chapter I"],
  [2680,"Meditations","Marcus Aurelius",180,["classic"],"Book One"],
  [1497,"The Republic","Plato",380,["classic"],"Chapter I"],
  // ── Epic Poetry
  [1727,"The Odyssey","Homer",800,["classic","adventure","fantasy"],"Tell me, O muse"],
  [6130,"The Iliad","Homer",800,["classic","adventure"],"Sing, O goddess"],
  [26,"Paradise Lost","John Milton",1667,["classic"],"BOOK I"],
  // ── Early 20th Century
  [4300,"Ulysses","James Joyce",1922,["classic"],"Stately, plump"],
  [5200,"The Metamorphosis","Franz Kafka",1915,["classic","scifi"],"One morning"],
];

// ── Standard Ebooks catalog (精校公版书，可加入书架)
const SE_BOOKS = [
  // ── Mystery / Detective
  { t:'The Moonstone',                       a:'Wilkie Collins',            y:1868, level:1, cat:['mystery'],              slug:'wilkie-collins/the-moonstone',                              mark:'I address these lines',        pal:['#fdf2e9','#d35400'], _se:true },
  { t:'The Woman in White',                  a:'Wilkie Collins',            y:1859, level:1, cat:['mystery','classic'],    slug:'wilkie-collins/the-woman-in-white',                         mark:'This is the story',            pal:['#eaecee','#2c3e50'], _se:true },
  { t:'The Innocence of Father Brown',       a:'G.K. Chesterton',          y:1911, level:1, cat:['mystery','short'],      slug:'g-k-chesterton/the-innocence-of-father-brown',             mark:'The suburb of Saffron Park',   pal:['#fdedec','#7b241c'], _se:true },
  { t:'The Red House Mystery',               a:'A.A. Milne',                y:1922, level:1, cat:['mystery'],              slug:'a-a-milne/the-red-house-mystery',                           mark:'It is a fact',                 pal:['#eaf2ff','#1a5276'], _se:true },
  { t:'The Adventures of Sherlock Holmes',   a:'Arthur Conan Doyle',        y:1892, level:1, cat:['mystery','short'],      slug:'arthur-conan-doyle/the-adventures-of-sherlock-holmes',     mark:'To Sherlock Holmes she',       pal:['#fdedec','#7b241c'], _se:true },
  { t:'The Hound of the Baskervilles',       a:'Arthur Conan Doyle',        y:1902, level:1, cat:['mystery','horror'],     slug:'arthur-conan-doyle/the-hound-of-the-baskervilles',         mark:'Mr. Sherlock Holmes',          pal:['#2c3e50','#f1c40f'], _se:true },
  { t:'A Study in Scarlet',                  a:'Arthur Conan Doyle',        y:1887, level:1, cat:['mystery'],              slug:'arthur-conan-doyle/a-study-in-scarlet',                    mark:'In the year 1878',             pal:['#fdedec','#922b21'], _se:true },
  { t:'The Sign of the Four',                a:'Arthur Conan Doyle',        y:1890, level:1, cat:['mystery'],              slug:'arthur-conan-doyle/the-sign-of-the-four',                  mark:'Sherlock Holmes took',         pal:['#fef9e7','#d35400'], _se:true },
  { t:'His Last Bow',                        a:'Arthur Conan Doyle',        y:1917, level:1, cat:['mystery','short'],      slug:'arthur-conan-doyle/his-last-bow',                          mark:'It was nine o\'clock',         pal:['#d5dbdb','#2c3e50'], _se:true },
  { t:'The Leavenworth Case',                a:'Anna Katharine Green',      y:1878, level:1, cat:['mystery'],              slug:'anna-katharine-green/the-leavenworth-case',                mark:'I had just finished',          pal:['#f4ecf7','#6c3483'], _se:true },
  { t:'Carmilla',                            a:'J. Sheridan Le Fanu',       y:1872, level:1, cat:['horror','mystery'],     slug:'j-sheridan-le-fanu/carmilla',                              mark:'In Styria, we',                pal:['#1c2833','#7b241c'], _se:true },
  // ── Adventure
  { t:'The Scarlet Pimpernel',               a:'Baroness Orczy',            y:1905, level:1, cat:['adventure','classic'],  slug:'baroness-orczy/the-scarlet-pimpernel',                     mark:'A surging, seething',          pal:['#fdedec','#922b21'], _se:true },
  { t:'Tarzan of the Apes',                  a:'Edgar Rice Burroughs',      y:1912, level:1, cat:['adventure'],            slug:'edgar-rice-burroughs/tarzan-of-the-apes',                  mark:'I had this story',             pal:['#d5f5e3','#1e8449'], _se:true },
  { t:"King Solomon's Mines",                a:'H. Rider Haggard',          y:1885, level:1, cat:['adventure'],            slug:'h-rider-haggard/king-solomons-mines',                      mark:'It is a curious thing',        pal:['#fef9e7','#b7950b'], _se:true },
  { t:'She',                                 a:'H. Rider Haggard',          y:1887, level:1, cat:['adventure','horror'],   slug:'h-rider-haggard/she',                                      mark:'My pen is bad',                pal:['#1c1c1c','#f1c40f'], _se:true },
  { t:'Treasure Island',                     a:'Robert Louis Stevenson',    y:1883, level:1, cat:['adventure'],            slug:'robert-louis-stevenson/treasure-island',                   mark:'Squire Trelawney',             pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'Kidnapped',                           a:'Robert Louis Stevenson',    y:1886, level:1, cat:['adventure'],            slug:'robert-louis-stevenson/kidnapped',                         mark:'I will begin the story',       pal:['#eaf2ff','#1a5276'], _se:true },
  { t:'The Call of the Wild',                a:'Jack London',               y:1903, level:1, cat:['adventure'],            slug:'jack-london/the-call-of-the-wild',                         mark:'Buck did not read',            pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'White Fang',                          a:'Jack London',               y:1906, level:1, cat:['adventure'],            slug:'jack-london/white-fang',                                   mark:'Dark spruce forest',           pal:['#d7dbdd','#2c3e50'], _se:true },
  { t:'The Sea-Wolf',                        a:'Jack London',               y:1904, level:1, cat:['adventure'],            slug:'jack-london/the-sea-wolf',                                 mark:'I scarcely know where',        pal:['#1a2a3a','#5dade2'], _se:true },
  { t:'Robinson Crusoe',                     a:'Daniel Defoe',              y:1719, level:1, cat:['adventure'],            slug:'daniel-defoe/robinson-crusoe',                             mark:'I was born in the year 1632',  pal:['#d5f5e3','#1e8449'], _se:true },
  { t:"Gulliver's Travels",                  a:'Jonathan Swift',            y:1726, level:1, cat:['adventure','scifi'],   slug:'jonathan-swift/gullivers-travels',                         mark:'My father had a small estate', pal:['#fef9e7','#d35400'], _se:true },
  { t:'The Count of Monte Cristo',           a:'Alexandre Dumas',           y:1844, level:1, cat:['adventure','mystery'],  slug:'alexandre-dumas/the-count-of-monte-cristo',                mark:'On the 24th of February',      pal:['#1c2833','#f1c40f'], _se:true },
  { t:'The Three Musketeers',                a:'Alexandre Dumas',           y:1844, level:1, cat:['adventure','classic'],  slug:'alexandre-dumas/the-three-musketeers',                     mark:'On the first Monday',          pal:['#fdedec','#922b21'], _se:true },
  { t:'Around the World in Eighty Days',     a:'Jules Verne',               y:1872, level:1, cat:['adventure'],            slug:'jules-verne/around-the-world-in-eighty-days',              mark:'Mr. Phileas Fogg lived',       pal:['#fef9e7','#b7950b'], _se:true },
  { t:'Twenty Thousand Leagues Under the Seas', a:'Jules Verne',            y:1870, level:1, cat:['adventure','scifi'],   slug:'jules-verne/twenty-thousand-leagues-under-the-seas',       mark:'The year 1866',                pal:['#1a2a3a','#5dade2'], _se:true },
  { t:'Journey to the Center of the Earth',  a:'Jules Verne',               y:1864, level:1, cat:['adventure','scifi'],   slug:'jules-verne/journey-to-the-center-of-the-earth',          mark:'Looking back',                 pal:['#1e8449','#f1c40f'], _se:true },
  { t:'The Adventures of Huckleberry Finn',  a:'Mark Twain',                y:1884, level:1, cat:['adventure','classic'], slug:'mark-twain/adventures-of-huckleberry-finn',                mark:"You don't know about me",      pal:['#fef9e7','#d35400'], _se:true },
  { t:'The Adventures of Tom Sawyer',        a:'Mark Twain',                y:1876, level:1, cat:['adventure','classic'], slug:'mark-twain/the-adventures-of-tom-sawyer',                  mark:'Tom!',                         pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'A Princess of Mars',                  a:'Edgar Rice Burroughs',      y:1912, level:1, cat:['scifi','adventure'],   slug:'edgar-rice-burroughs/a-princess-of-mars',                 mark:'I am a very old man',          pal:['#fdedec','#c0392b'], _se:true },
  { t:'The Jungle Book',                     a:'Rudyard Kipling',           y:1894, level:1, cat:['adventure','classic'], slug:'rudyard-kipling/the-jungle-book',                          mark:"It was seven o'clock",         pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'Kim',                                 a:'Rudyard Kipling',           y:1901, level:2, cat:['adventure','classic'], slug:'rudyard-kipling/kim',                                      mark:'He sat, in defiance',          pal:['#fef9e7','#b7950b'], _se:true },
  // ── Science Fiction
  { t:'The Time Machine',                    a:'H.G. Wells',                y:1895, level:1, cat:['scifi'],               slug:'h-g-wells/the-time-machine',                               mark:'The Time Traveller',           pal:['#1c1c1c','#5dade2'], _se:true },
  { t:'The War of the Worlds',               a:'H.G. Wells',                y:1898, level:1, cat:['scifi'],               slug:'h-g-wells/the-war-of-the-worlds',                          mark:'No one would have believed',   pal:['#922b21','#f1c40f'], _se:true },
  { t:'The Invisible Man',                   a:'H.G. Wells',                y:1897, level:1, cat:['scifi','adventure'],   slug:'h-g-wells/the-invisible-man',                              mark:'The stranger came early',      pal:['#d5dbdd','#2c3e50'], _se:true },
  { t:'The Island of Doctor Moreau',         a:'H.G. Wells',                y:1896, level:1, cat:['scifi','horror'],      slug:'h-g-wells/the-island-of-doctor-moreau',                   mark:'I do not propose to add',      pal:['#1e8449','#f1c40f'], _se:true },
  { t:'The First Men in the Moon',           a:'H.G. Wells',                y:1901, level:1, cat:['scifi','adventure'],   slug:'h-g-wells/the-first-men-in-the-moon',                     mark:'As I sit here writing',        pal:['#d7dbdd','#5dade2'], _se:true },
  { t:'Frankenstein',                        a:'Mary Shelley',              y:1818, level:2, cat:['scifi','horror'],      slug:'mary-shelley/frankenstein',                                mark:'You will rejoice to hear',      pal:['#1c2833','#7f8c8d'], _se:true },
  // ── Horror
  { t:'Dracula',                             a:'Bram Stoker',               y:1897, level:1, cat:['horror','mystery'],    slug:'bram-stoker/dracula',                                      mark:'3 May. Bistritz.',             pal:['#1c2833','#922b21'], _se:true },
  { t:'The Strange Case of Dr Jekyll and Mr Hyde', a:'Robert Louis Stevenson', y:1886, level:1, cat:['horror','mystery'], slug:'robert-louis-stevenson/the-strange-case-of-dr-jekyll-and-mr-hyde', mark:'Mr. Utterson the lawyer', pal:['#1c2833','#7f8c8d'], _se:true },
  { t:'The Picture of Dorian Gray',          a:'Oscar Wilde',               y:1890, level:1, cat:['classic','horror'],   slug:'oscar-wilde/the-picture-of-dorian-gray',                  mark:'The studio was filled',        pal:['#1c1c1c','#f1c40f'], _se:true },
  { t:'The Turn of the Screw',               a:'Henry James',               y:1898, level:1, cat:['horror','classic'],   slug:'henry-james/the-turn-of-the-screw',                        mark:'The story had held us',        pal:['#2c3e50','#7f8c8d'], _se:true },
  // ── Classic Literature
  { t:'Pride and Prejudice',                 a:'Jane Austen',               y:1813, level:1, cat:['classic'],             slug:'jane-austen/pride-and-prejudice',                          mark:'It is a truth universally',    pal:['#fdf2e9','#7b241c'], _se:true },
  { t:'Sense and Sensibility',               a:'Jane Austen',               y:1811, level:1, cat:['classic'],             slug:'jane-austen/sense-and-sensibility',                        mark:'The family of Dashwood',       pal:['#f4f6f7','#2c3e50'], _se:true },
  { t:'Emma',                                a:'Jane Austen',               y:1815, level:1, cat:['classic'],             slug:'jane-austen/emma',                                         mark:'Emma Woodhouse, handsome',     pal:['#e8f8f5','#1a6b4a'], _se:true },
  { t:'Northanger Abbey',                    a:'Jane Austen',               y:1817, level:1, cat:['classic'],             slug:'jane-austen/northanger-abbey',                             mark:'No one who had ever seen',     pal:['#fef9e7','#b7950b'], _se:true },
  { t:'Persuasion',                          a:'Jane Austen',               y:1817, level:1, cat:['classic'],             slug:'jane-austen/persuasion',                                   mark:'Sir Walter Elliot',            pal:['#eaf2ff','#1a5276'], _se:true },
  { t:'Mansfield Park',                      a:'Jane Austen',               y:1814, level:2, cat:['classic'],             slug:'jane-austen/mansfield-park',                               mark:'About thirty years ago',       pal:['#f4f6f7','#7d6608'], _se:true },
  { t:'Jane Eyre',                           a:'Charlotte Brontë',          y:1847, level:1, cat:['classic'],             slug:'charlotte-bronte/jane-eyre',                               mark:'There was no possibility',     pal:['#fdedec','#922b21'], _se:true },
  { t:'Wuthering Heights',                   a:'Emily Brontë',              y:1847, level:2, cat:['classic'],             slug:'emily-bronte/wuthering-heights',                           mark:'1801—I have just returned',    pal:['#2c3e50','#85929e'], _se:true },
  { t:'The Tenant of Wildfell Hall',         a:'Anne Brontë',               y:1848, level:2, cat:['classic'],             slug:'anne-bronte/the-tenant-of-wildfell-hall',                 mark:'You must go back',             pal:['#e8ecf0','#566573'], _se:true },
  { t:'Great Expectations',                  a:'Charles Dickens',           y:1861, level:1, cat:['classic'],             slug:'charles-dickens/great-expectations',                       mark:"My father's family name",      pal:['#eaf2ff','#1a5276'], _se:true },
  { t:'A Tale of Two Cities',                a:'Charles Dickens',           y:1859, level:1, cat:['classic','adventure'], slug:'charles-dickens/a-tale-of-two-cities',                     mark:'It was the best of times',     pal:['#fdedec','#7b241c'], _se:true },
  { t:'Oliver Twist',                        a:'Charles Dickens',           y:1837, level:1, cat:['classic'],             slug:'charles-dickens/oliver-twist',                             mark:'Among other public buildings', pal:['#f4ecf7','#6c3483'], _se:true },
  { t:'David Copperfield',                   a:'Charles Dickens',           y:1850, level:2, cat:['classic'],             slug:'charles-dickens/david-copperfield',                        mark:'Whether I shall turn out',     pal:['#e8f4f8','#1a5276'], _se:true },
  { t:'Bleak House',                         a:'Charles Dickens',           y:1853, level:2, cat:['classic','mystery'],   slug:'charles-dickens/bleak-house',                              mark:'London. Michaelmas Term',      pal:['#d5dbdb','#2c3e50'], _se:true },
  { t:'The Importance of Being Earnest',     a:'Oscar Wilde',               y:1895, level:1, cat:['classic','short'],     slug:'oscar-wilde/the-importance-of-being-earnest',             mark:'Morning-room in Algernon',     pal:['#fef9e7','#d35400'], _se:true },
  { t:'Middlemarch',                         a:'George Eliot',              y:1871, level:2, cat:['classic'],             slug:'george-eliot/middlemarch',                                 mark:'Who that cares much',          pal:['#f4f6f7','#7d6608'], _se:true },
  { t:'The Mill on the Floss',               a:'George Eliot',              y:1860, level:2, cat:['classic'],             slug:'george-eliot/the-mill-on-the-floss',                      mark:'A wide plain',                 pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'Silas Marner',                        a:'George Eliot',              y:1861, level:1, cat:['classic'],             slug:'george-eliot/silas-marner',                                mark:'In the days when the spinning-wheels', pal:['#fef9e7','#b7950b'], _se:true },
  { t:"Tess of the d'Urbervilles",           a:'Thomas Hardy',              y:1891, level:2, cat:['classic'],             slug:'thomas-hardy/tess-of-the-d-urbervilles',                  mark:'On an evening in the latter',  pal:['#fdedec','#7b241c'], _se:true },
  { t:'Far from the Madding Crowd',          a:'Thomas Hardy',              y:1874, level:2, cat:['classic'],             slug:'thomas-hardy/far-from-the-madding-crowd',                 mark:'When Farmer Oak smiled',       pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'The Return of the Native',            a:'Thomas Hardy',              y:1878, level:2, cat:['classic'],             slug:'thomas-hardy/the-return-of-the-native',                   mark:'A Saturday afternoon',         pal:['#fef9e7','#d35400'], _se:true },
  { t:'The Mayor of Casterbridge',           a:'Thomas Hardy',              y:1886, level:2, cat:['classic'],             slug:'thomas-hardy/the-mayor-of-casterbridge',                  mark:'One evening of late summer',   pal:['#e8ecf0','#566573'], _se:true },
  { t:'Vanity Fair',                         a:'William M. Thackeray',      y:1848, level:2, cat:['classic'],             slug:'william-makepeace-thackeray/vanity-fair',                 mark:'While the present century',    pal:['#fef9e7','#d35400'], _se:true },
  { t:'The Warden',                          a:'Anthony Trollope',          y:1855, level:1, cat:['classic'],             slug:'anthony-trollope/the-warden',                              mark:'The Rev. Septimus Harding',   pal:['#e8f4f8','#1a5276'], _se:true },
  { t:'Barchester Towers',                   a:'Anthony Trollope',          y:1857, level:2, cat:['classic'],             slug:'anthony-trollope/barchester-towers',                       mark:'In the latter days',           pal:['#d5dbdb','#2c3e50'], _se:true },
  { t:'The Ambassadors',                     a:'Henry James',               y:1903, level:2, cat:['classic'],             slug:'henry-james/the-ambassadors',                              mark:"Strether's first question",    pal:['#f4f6f7','#2c3e50'], _se:true },
  { t:'Washington Square',                   a:'Henry James',               y:1880, level:1, cat:['classic'],             slug:'henry-james/washington-square',                            mark:'During a portion of the first', pal:['#fdf2e9','#7b241c'], _se:true },
  { t:'Heart of Darkness',                   a:'Joseph Conrad',             y:1899, level:2, cat:['adventure','classic'], slug:'joseph-conrad/heart-of-darkness',                          mark:'The Nellie, a cruising yawl',  pal:['#1c2833','#d4ac0d'], _se:true },
  { t:'Lord Jim',                            a:'Joseph Conrad',             y:1900, level:2, cat:['adventure','classic'], slug:'joseph-conrad/lord-jim',                                   mark:'He was an inch',               pal:['#1a2a3a','#5dade2'], _se:true },
  { t:'Nostromo',                            a:'Joseph Conrad',             y:1904, level:2, cat:['adventure','classic'], slug:'joseph-conrad/nostromo',                                   mark:'In the time of Spanish rule',  pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'The Secret Agent',                    a:'Joseph Conrad',             y:1907, level:2, cat:['mystery','classic'],   slug:'joseph-conrad/the-secret-agent',                          mark:'Mr. Verloc, going out',        pal:['#2c3e50','#85929e'], _se:true },
  { t:'Anna Karenina',                       a:'Leo Tolstoy',               y:1878, level:2, cat:['classic'],             slug:'leo-tolstoy/anna-karenina',                                mark:'All happy families',           pal:['#fdedec','#922b21'], _se:true },
  { t:'War and Peace',                       a:'Leo Tolstoy',               y:1869, level:2, cat:['classic','adventure'], slug:'leo-tolstoy/war-and-peace',                                mark:'"Well, Prince"',               pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'Crime and Punishment',                a:'Fyodor Dostoevsky',         y:1866, level:2, cat:['classic','mystery'],   slug:'fyodor-dostoevsky/crime-and-punishment',                  mark:'On an exceptionally hot evening', pal:['#1c2833','#d4ac0d'], _se:true },
  { t:'The Brothers Karamazov',              a:'Fyodor Dostoevsky',         y:1880, level:2, cat:['classic'],             slug:'fyodor-dostoevsky/the-brothers-karamazov',                mark:'Alexei Fyodorovich Karamazov', pal:['#2c3e50','#85929e'], _se:true },
  { t:'Les Misérables',                      a:'Victor Hugo',               y:1862, level:2, cat:['classic','adventure'], slug:'victor-hugo/les-miserables',                               mark:'In 1815, M. Charles',          pal:['#fdf2e9','#d35400'], _se:true },
  { t:'A Room with a View',                  a:'E.M. Forster',              y:1908, level:1, cat:['classic'],             slug:'e-m-forster/a-room-with-a-view',                          mark:'The Signora had no business',  pal:['#eaf2ff','#1a5276'], _se:true },
  { t:'Where Angels Fear to Tread',          a:'E.M. Forster',              y:1905, level:1, cat:['classic'],             slug:'e-m-forster/where-angels-fear-to-tread',                  mark:'They were all at Charing Cross', pal:['#fef9e7','#7d6608'], _se:true },
  { t:'Martin Eden',                         a:'Jack London',               y:1909, level:2, cat:['classic','adventure'], slug:'jack-london/martin-eden',                                  mark:'The one opened the door',      pal:['#fef9e7','#b7950b'], _se:true },
  // ── Advanced
  { t:'Ethan Frome',                         a:'Edith Wharton',             y:1911, level:1, cat:['classic'],             slug:'edith-wharton/ethan-frome',                                mark:'I had the story',              pal:['#d7dbdd','#2c3e50'], _se:true },
  { t:'The Age of Innocence',                a:'Edith Wharton',             y:1920, level:2, cat:['classic'],             slug:'edith-wharton/the-age-of-innocence',                      mark:'On a January evening',         pal:['#f4f6f7','#2c3e50'], _se:true },
  { t:'My Ántonia',                          a:'Willa Cather',              y:1918, level:2, cat:['classic'],             slug:'willa-cather/my-antonia',                                  mark:'I first heard',                pal:['#fef9e7','#7d6608'], _se:true },
  { t:'The Portrait of a Lady',              a:'Henry James',               y:1881, level:2, cat:['classic'],             slug:'henry-james/the-portrait-of-a-lady',                      mark:'Under certain circumstances',  pal:['#f4f6f7','#2c3e50'], _se:true },
  { t:'Howards End',                         a:'E.M. Forster',              y:1910, level:2, cat:['classic'],             slug:'e-m-forster/howards-end',                                  mark:'One may as well begin',        pal:['#e8f8f5','#1a6b4a'], _se:true },
  // ── Children's / Family
  { t:"Alice's Adventures in Wonderland",    a:'Lewis Carroll',             y:1865, level:1, cat:['classic','short'],     slug:'lewis-carroll/alices-adventures-in-wonderland',            mark:'Alice was beginning',          pal:['#f4ecf7','#1a5276'], _se:true },
  { t:'Through the Looking-Glass',           a:'Lewis Carroll',             y:1871, level:1, cat:['classic','short'],     slug:'lewis-carroll/through-the-looking-glass',                 mark:'One thing was certain',        pal:['#eaf2ff','#6c3483'], _se:true },
  { t:'The Wind in the Willows',             a:'Kenneth Grahame',           y:1908, level:1, cat:['classic'],             slug:'kenneth-grahame/the-wind-in-the-willows',                 mark:'The Mole had been',            pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'Anne of Green Gables',               a:'L.M. Montgomery',           y:1908, level:1, cat:['classic'],             slug:'l-m-montgomery/anne-of-green-gables',                     mark:'Mrs. Rachel Lynde lived',      pal:['#fdedec','#d35400'], _se:true },
  { t:'Little Women',                        a:'Louisa May Alcott',         y:1868, level:1, cat:['classic'],             slug:'louisa-may-alcott/little-women',                          mark:'"Christmas won\'t be Christmas"', pal:['#fef9e7','#7d6608'], _se:true },
  { t:'The Secret Garden',                   a:'Frances Hodgson Burnett',   y:1911, level:1, cat:['classic'],             slug:'frances-hodgson-burnett/the-secret-garden',               mark:'When Mary Lennox',             pal:['#d5f5e3','#1e8449'], _se:true },
  { t:'A Little Princess',                   a:'Frances Hodgson Burnett',   y:1905, level:1, cat:['classic'],             slug:'frances-hodgson-burnett/a-little-princess',               mark:'Once on a dark winter',        pal:['#fdf2e9','#922b21'], _se:true },
  // ── Short Stories
  { t:'A Connecticut Yankee in King Arthur\'s Court', a:'Mark Twain',       y:1889, level:1, cat:['adventure','scifi'],  slug:'mark-twain/a-connecticut-yankee-in-king-arthurs-court',   mark:'Camelot—"Camelot,"',           pal:['#fdedec','#7b241c'], _se:true },
];
SE_BOOKS.forEach(b => { b.url = 'se://' + b.slug; b.isbn = ''; });

// Category labels
const CAT_LABELS = {all:'全部',classic:'经典',mystery:'推理',adventure:'冒险',scifi:'科幻',horror:'恐怖',short:'短篇'};
let libFilter = 'all', libQuery = '';

// ── Cover URL
function coverUrl(isbn){ return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`; }
function gbCoverUrl(id){ return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`; }

// ── CORS proxies, tried serially (fastest/most reliable first).
// Self-hosted Cloudflare Worker (edge-cached, fastest) — set BOOK_PROXY after
// deploying cloudflare-proxy/ (see its README). When set it becomes the primary
// proxy and the public ones below are just fallbacks. Empty = use public only.
const BOOK_PROXY = 'https://linggo-proxy.langhua98.workers.dev';
//
// Public fallbacks (2025): corsproxy.io now 403s anonymous traffic and thingproxy
// is dead. cors.eu.org is the fastest public option and handles full-size books
// (~700 KB in ~8 s); proxy.cors.sh / allorigins are slower backups.
const PROXIES = [
  ...(BOOK_PROXY ? [u => `${BOOK_PROXY}/?url=${encodeURIComponent(u)}`] : []),
  u => `https://cors.eu.org/${u}`,
  u => `https://proxy.cors.sh/${u}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function _tryFetch(mk, url, ms){
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try{
    const r = await fetch(mk(url), {signal: ctrl.signal});
    clearTimeout(tid);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  }catch(e){ clearTimeout(tid); throw e; }
}

// Stream one proxy with progress + a STALL watchdog: abort only after `stallMs`
// of zero new bytes, so slow-but-progressing large-book downloads aren't killed
// by a fixed deadline (the old 9 s hard cap was the main cause of timeouts).
async function _streamProxy(mk, rawUrl, onProgress, stallMs){
  const ctrl = new AbortController();
  let tid = setTimeout(() => ctrl.abort(), stallMs);
  const kick = () => { clearTimeout(tid); tid = setTimeout(() => ctrl.abort(), stallMs); };
  try{
    const resp = await fetch(mk(rawUrl), {signal: ctrl.signal});
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    kick();
    const total  = parseInt(resp.headers.get('content-length') || '0');
    const reader = resp.body.getReader();
    const chunks = []; let got = 0;
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      kick();
      chunks.push(value); got += value.length;
      const pct = total > 0 ? Math.round(got/total*100) : Math.min(90, Math.round(got/5000));
      onProgress(pct);
    }
    clearTimeout(tid);
    if(got === 0) throw new Error('empty body');
    onProgress(100);
    const buf = new Uint8Array(got); let pos = 0;
    for(const c of chunks){ buf.set(c, pos); pos += c.length; }
    return new TextDecoder('utf-8').decode(buf);
  }catch(e){ clearTimeout(tid); throw e; }
}

async function fetchWithProgress(rawUrl, onProgress){
  let lastErr;
  for(const mk of PROXIES){
    try{ return await _streamProxy(mk, rawUrl, onProgress, 15000); }
    catch(e){ lastErr = e; console.warn('proxy fail', mk(rawUrl).split('/')[2], e.message); onProgress(0); }
  }
  throw new Error('all proxies failed: ' + (lastErr?.message || ''));
}

// ── Standard Ebooks: strip HTML to plain text
function seHtmlToText(html){
  const doc = new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('nav,script,style').forEach(el => el.remove());
  return (doc.body?.textContent||'')
    .replace(/\t/g,' ').replace(/ {3,}/g,'  ').replace(/\n{4,}/g,'\n\n\n').trim();
}

// ── Fetch SE single-page book through CORS proxy
async function fetchSEText(slug){
  const url = `https://standardebooks.org/ebooks/${slug}/text/single-page`;
  for(const mk of PROXIES){
    try{
      const resp = await _tryFetch(mk, url, 30000);
      return seHtmlToText(await resp.text());
    }catch(e){ console.warn('SE proxy fail',e); }
  }
  throw new Error('all proxies failed');
}

// ── Load SE book (fetch HTML → strip → IDB cache)
async function loadSEBook(book, cardEl){
  // slug is stored on the object when from SE_BOOKS; derive from url when restored from storage
  const slug = book.slug || book.url.slice(5); // 'se://'.length === 5
  try{
    const cached = await idbGet(book.url);
    if(cached){ openBook(book,cached); return; }
  }catch(e){}

  setCardAction(cardEl,'downloading',0);
  let pct = 0;
  const progTimer = setInterval(()=>{
    pct = Math.min(90, pct+2);
    setCardAction(cardEl,'downloading',pct);
  },1500);

  try{
    let txt = await fetchSEText(slug);
    clearInterval(progTimer);
    const si = book.mark ? txt.indexOf(book.mark) : -1;
    if(si > 0) txt = txt.substring(si);
    await idbSave(book.url, txt);
    setCardAction(cardEl,'cached');
    openBook(book, txt);
  }catch(e){
    clearInterval(progTimer);
    setCardAction(cardEl,'error',`https://standardebooks.org/ebooks/${slug}`);
  }
}

// ── Card state manager
function setCardAction(cardEl, state, pct){
  if(!cardEl) return;
  const el = cardEl.querySelector('.bk-action');
  if(!el) return;
  if(state === 'ready'){
    el.innerHTML = '<button class="bk-btn">开始阅读</button>';
    el.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      loadBook(cardEl._book, cardEl);
    });
  } else if(state === 'cached'){
    el.innerHTML = '<button class="bk-btn bk-btn-cached">继续阅读 ›</button>';
    el.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      loadBook(cardEl._book, cardEl);
    });
  } else if(state === 'downloading'){
    const p = (typeof pct === 'number' && pct > 0) ? pct : 0;
    el.innerHTML = `
      <div class="bk-prog-wrap"><div class="bk-prog-bar" style="width:${p}%"></div></div>
      <span class="bk-prog-label">${p > 0 ? p+'%' : '连接中…'}</span>`;
  } else if(state === 'error'){
    // pct = book.url here
    el.innerHTML = `<a class="bk-btn bk-btn-err" href="${pct}" target="_blank" title="网络加载失败，点击直接下载 TXT">↓ 下载</a>`;
    el.querySelector('a').addEventListener('click', e => e.stopPropagation());
  } else {
    // init / checking
    el.innerHTML = '<div class="bk-btn-ghost">检查中…</div>';
  }
}

// ── Build single book card
function buildCard(book){
  const div = document.createElement('div');
  div.className = 'bk';
  div._book = book;
  const [c1,c2] = book.pal || ['#667eea','#764ba2'];
  const hasIsbn = book.isbn && book.isbn !== 'null';
  const imgSrc  = hasIsbn ? coverUrl(book.isbn)
                : book._gbId ? gbCoverUrl(book._gbId)
                : null;
  div.innerHTML = `
    <div class="bk-cover">
      ${imgSrc ? `<img src="${_esc(imgSrc)}" alt="${_esc(book.t)}" loading="lazy">` : ''}
      <div class="bk-cover-fallback" style="${imgSrc?'display:none;':'display:flex;'}background:linear-gradient(145deg,${c1},${c2})">
        <div class="bk-fb-title">${_esc(book.t)}</div>
        <div class="bk-fb-author">${_esc(book.a.split(' ').pop())}</div>
        <div class="bk-fb-deco"></div>
      </div>
    </div>
    <div class="bk-title">${_esc(book.t)}</div>
    <div class="bk-author">${_esc(book.a)}</div>
    <div class="bk-action"></div>`;

  if(imgSrc){
    const img = div.querySelector('img');
    const fb  = div.querySelector('.bk-cover-fallback');
    img.onerror = () => { img.style.display='none'; fb.style.display='flex'; };
  }

  // Tap cover → preview sheet
  div.querySelector('.bk-cover').addEventListener('click', e => {
    e.stopPropagation();
    openBookPreview(book, div);
  });

  // check local cache, set initial button state
  setCardAction(div, 'init');
  idbHas(book.url).then(has => setCardAction(div, has ? 'cached' : 'ready'));

  return div;
}

// ── Book Preview Sheet
const PREVIEW_CACHE = new Map();
let _previewBook = null;

function openBookPreview(book, cardEl, opts){
  opts = opts || {};
  _previewBook = book;
  const overlay = document.getElementById('book-prev-overlay');
  const sheet   = document.getElementById('book-prev');

  // Cover
  const [c1,c2] = book.pal || ['#667eea','#764ba2'];
  const fb  = document.getElementById('bprev-fb');
  const img = document.getElementById('bprev-img');
  fb.style.background = `linear-gradient(145deg,${c1},${c2})`;
  fb.textContent = book.t;
  const hasIsbn = book.isbn && book.isbn !== 'null' && book.isbn !== '';
  const src = hasIsbn ? coverUrl(book.isbn).replace('-M.jpg','-L.jpg')
            : book._gbId ? gbCoverUrl(book._gbId) : null;
  if(src){
    img.src = src; img.style.display='';  fb.style.display='none';
    img.onerror = ()=>{ img.style.display='none'; fb.style.display='flex'; };
  } else {
    img.style.display='none'; fb.style.display='flex';
  }

  // Text info
  document.getElementById('bprev-title').textContent = book.t;
  document.getElementById('bprev-meta').textContent  =
    `${book.a}${book.y ? ' · ' + book.y : ''}`;
  document.getElementById('bprev-cats').innerHTML =
    (book.cat||[]).map(c=>`<span class="bprev-cat">${CAT_LABELS[c]||c}</span>`).join('');
  document.getElementById('bprev-desc').textContent = '加载简介中…';
  const zhEl = document.getElementById('bprev-desc-zh');
  if(zhEl){ zhEl.textContent = ''; zhEl.style.display = 'none'; }

  // Read button: download + open the book directly (works for any book).
  document.getElementById('bprev-read-btn').onclick = ()=>{
    closeBookPreview();
    loadBook(book, cardEl);
  };

  // Add button: only for search results that aren't built-in / already added.
  const addBtn = document.getElementById('bprev-add-btn');
  if(addBtn){
    const owned = !!book._builtin || userBooks.some(b => b.url === book.url);
    if(opts.search && !owned){
      addBtn.style.display = '';
      addBtn.disabled = false;
      addBtn.textContent = '+ 添加到书架';
      addBtn.onclick = async ()=>{
        addBtn.disabled = true; addBtn.textContent = '添加中…';
        const ok = await addUserBook(book);
        addBtn.textContent = ok ? '已添加 ✓' : '添加失败';
        // keep the underlying search card's button in sync
        const cb = cardEl && cardEl.querySelector('.gb-add-btn');
        if(cb && ok){ cb.disabled = true; cb.textContent = '已添加'; }
      };
    } else {
      addBtn.style.display = 'none';
    }
  }

  // Animate in
  // Shared-element transition: the tapped card cover morphs into the sheet
  // cover. The source loses its name inside the mutation so only ONE element
  // carries `book-cover` in each snapshot (a dup would abort the transition).
  const _cardCover  = cardEl && cardEl.querySelector('.bk-cover, .gb-cover');
  const _sheetCover = sheet.querySelector('.bprev-cover-wrap');
  const _shineCover = () => {
    if(!_sheetCover) return;
    _sheetCover.classList.remove('shine');
    void _sheetCover.offsetWidth;   // reflow so the animation restarts each open
    _sheetCover.classList.add('shine');
  };
  const _doOpen = () => { overlay.classList.add('vis'); sheet.classList.add('open'); };
  if(document.startViewTransition && _cardCover && _sheetCover &&
     !matchMedia('(prefers-reduced-motion: reduce)').matches){
    _cardCover.style.viewTransitionName = 'book-cover';
    const vt = document.startViewTransition(() => {
      _cardCover.style.viewTransitionName = '';
      _sheetCover.style.viewTransitionName = 'book-cover';
      _doOpen();
    });
    vt.finished.finally(() => {
      _cardCover.style.viewTransitionName = '';
      _sheetCover.style.viewTransitionName = '';
      setTimeout(_shineCover, 90);
    });
  } else {
    _doOpen();
    setTimeout(_shineCover, 340);
  }

  fetchBookDesc(book);
}

function closeBookPreview(){
  document.getElementById('book-prev-overlay').classList.remove('vis');
  document.getElementById('book-prev').classList.remove('open');
  const _sc = document.querySelector('.bprev-cover-wrap');
  if(_sc) _sc.classList.remove('shine');
  _previewBook = null;
}

async function fetchBookDesc(book){
  const key = book.url || book.t;
  if(PREVIEW_CACHE.has(key)){
    const text = PREVIEW_CACHE.get(key);
    _setDesc(book, text);
    _fetchZhDesc(book, text);
    return;
  }
  // Try direct title, then "(novel)" variant
  for(const q of [book.t, book.t + ' (novel)']){
    try{
      const ctrl = new AbortController();
      const tid  = setTimeout(()=>ctrl.abort(), 8000);
      const resp = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.replace(/ /g,'_'))}`,
        {signal:ctrl.signal}
      );
      clearTimeout(tid);
      if(!resp.ok) continue;
      const d = await resp.json();
      if(d.type === 'standard' && d.extract){
        let text = d.extract;
        if(text.length > 360) text = text.slice(0, text.lastIndexOf(' ', 360)) + '…';
        // Use Wikipedia thumbnail as cover if we have no image
        if(d.thumbnail?.source){
          const img = document.getElementById('bprev-img');
          if(img.style.display === 'none'){
            img.src = d.thumbnail.source;
            img.style.display = '';
            document.getElementById('bprev-fb').style.display = 'none';
            img.onerror = ()=>{ img.style.display='none'; document.getElementById('bprev-fb').style.display='flex'; };
          }
        }
        PREVIEW_CACHE.set(key, text);
        _setDesc(book, text);
        _fetchZhDesc(book, text);
        return;
      }
    }catch(e){}
  }
  const fallback = '暂无简介。';
  PREVIEW_CACHE.set(key, fallback);
  _setDesc(book, fallback);
}

const ZH_CACHE = new Map();
async function _fetchZhDesc(book, enText){
  if(!enText || enText === '暂无简介。') return;
  const key = book.url || book.t;
  if(ZH_CACHE.has(key)){
    _setZhDesc(book, ZH_CACHE.get(key)); return;
  }
  const toTrans = enText.length > 300
    ? enText.slice(0, enText.lastIndexOf(' ', 300))
    : enText;
  try{
    const ctrl = new AbortController();
    const tid  = setTimeout(()=>ctrl.abort(), 10000);
    const resp = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(toTrans)}&langpair=en|zh-CN`,
      {signal:ctrl.signal}
    );
    clearTimeout(tid);
    if(!resp.ok) return;
    const data = await resp.json();
    const zh = data.responseData?.translatedText;
    if(zh && zh.length > 10 && !/MYMEMORY WARNING/i.test(zh)){
      ZH_CACHE.set(key, zh);
      _setZhDesc(book, zh);
    }
  }catch(e){}
}

function _setDesc(book, text){
  if(_previewBook && (_previewBook.url===book.url || _previewBook.t===book.t)){
    document.getElementById('bprev-desc').textContent = text;
  }
}

function _setZhDesc(book, text){
  if(_previewBook && (_previewBook.url===book.url || _previewBook.t===book.t)){
    const el = document.getElementById('bprev-desc-zh');
    if(el){ el.textContent = text; el.style.display = ''; }
  }
}

document.getElementById('book-prev-overlay').addEventListener('click', closeBookPreview);

// ── Load book: try cache first, then download
async function loadBook(book, cardEl){
  if(book._se || book.url?.startsWith('se://')){ await loadSEBook(book,cardEl); return; }
  // 1. Try local IndexedDB cache
  try{
    const cached = await idbGet(book.url);
    if(cached){
      openBook(book, cached);
      return;
    }
  }catch(e){}

  // 2. Download with real-time progress
  setCardAction(cardEl, 'downloading', 0);
  try{
    let txt = await fetchWithProgress(book.url, pct => {
      setCardAction(cardEl, 'downloading', pct);
    });
    // Strip Gutenberg boilerplate
    const si = txt.indexOf(book.mark);
    if(si > 0) txt = txt.substring(si);
    for(const m of ['*** END OF','***END OF','End of Project Gutenberg']){
      const ei = txt.indexOf(m);
      if(ei > 500){ txt = txt.substring(0,ei); break; }
    }
    // Save locally
    await idbSave(book.url, txt);
    setCardAction(cardEl, 'cached');
    openBook(book, txt);
  }catch(e){
    if(cardEl) setCardAction(cardEl, 'error', book.url);
    else toast('加载失败，请检查网络后重试');
  }
}

// ── Open book in reader
// ── Smooth native view transitions (View Transitions API).
// No-op fallback on unsupported browsers or when the user prefers reduced motion.
function withVT(mutate){
  if(!document.startViewTransition ||
     matchMedia('(prefers-reduced-motion: reduce)').matches){
    mutate(); return;
  }
  try { document.startViewTransition(mutate); }
  catch(e){ mutate(); }
}

function openBook(book, text){
  S.fileName = book.t;
  document.getElementById('filename').textContent = book.t;
  loadProg();
  // Crossfade the library → reader swap (content is built inside the transition
  // so the incoming snapshot already shows the rendered page).
  withVT(() => {
    document.getElementById('library').classList.remove('open');
    document.getElementById('overlay').classList.remove('vis');
    buildReader(text);
  });
  toast('《' + book.t + '》');
}

// ── Render library rows
function renderLib(){
  BOOKS.forEach((level, li) => {
    const row = document.getElementById(`lib-row-${li}`);
    if(!row) return;
    row.innerHTML = '';
    // Level filter: hide entire section if not matching
    if(libFilter.startsWith('lv-') && libFilter !== `lv-${li}`){
      document.getElementById(`lib-level-${li}`).style.display = 'none';
      return;
    }
    const cat = libFilter.startsWith('lv-') ? 'all' : libFilter;
    const filtered = level.filter(b => {
      const catOk = cat === 'all' || b.cat.includes(cat);
      const q     = libQuery.toLowerCase();
      const qOk   = !q || b.t.toLowerCase().includes(q) || b.a.toLowerCase().includes(q);
      return catOk && qOk;
    });
    filtered.forEach(b => row.appendChild(buildCard(b)));
    document.getElementById(`lib-level-${li}`).style.display = filtered.length ? '' : 'none';
  });
  const any = [0,1,2].some(i => document.getElementById(`lib-level-${i}`).style.display !== 'none');
  document.getElementById('lib-empty').style.display = any ? 'none' : '';
}

// ── Unified search
let libSearchTimer;
const libSearchEl    = document.getElementById('lib-search');
const libSearchClear = document.getElementById('lib-search-clear');
const libSearchPanel = document.getElementById('lib-search-panel');
const libScrollEl  = document.getElementById('lib-scroll');
const libCatsBarEl = document.querySelector('.lib-cats-bar');
const LEVEL_NAMES    = ['入门', '中级', '进阶'];

function showSearchPanel(q){
  libSearchPanel.style.display = '';
  libScrollEl.style.display    = 'none';
  
  libCatsBarEl.style.display   = 'none';
  libSearchClear.style.display = '';

  // local results
  const ql = q.toLowerCase();
  const allBooks = BOOKS.flat();
  const matches = allBooks.filter(b =>
    b.t.toLowerCase().includes(ql) || b.a.toLowerCase().includes(ql)
  );
  const list = document.getElementById('lsp-local-list');
  list.innerHTML = '';
  matches.slice(0,4).forEach(b => {
    const lv = BOOKS.findIndex(arr => arr.includes(b));
    const row = document.createElement('div');
    row.className = 'lsp-local-item';
    row.innerHTML = `<div class="lsp-item-title">${b.t}</div>
      <div class="lsp-item-meta">${b.a} · ${LEVEL_NAMES[lv]??''}</div>`;
    row.addEventListener('click', () => {
      hideSearchPanel();
      document.getElementById('library').classList.remove('open');
      loadBook(b, null);
    });
    list.appendChild(row);
  });
  const moreBtn = document.getElementById('lsp-more');
  if(matches.length > 4){
    moreBtn.textContent = `查看全部 ${matches.length} 个结果 →`;
    moreBtn.style.display = '';
    moreBtn.onclick = () => {
      libSearchPanel.style.display = 'none';
      libScrollEl.style.display    = '';
      
      libCatsBarEl.style.display   = '';
      libQuery = q;
      renderLib();
    };
  } else {
    moreBtn.style.display = 'none';
  }
  document.getElementById('lsp-local').style.display = matches.length ? '' : 'none';
}

function hideSearchPanel(){
  libSearchPanel.style.display = 'none';
  libScrollEl.style.display    = '';
  
  libCatsBarEl.style.display   = '';
  libSearchClear.style.display = 'none';
  libSearchEl.value = '';
  libQuery = '';
  renderLib();
}

function closeGbPanel(){
  gbPanel.style.display = 'none';
}

function openBrowsePanel(){
  libSearchPanel.style.display = 'none';
  libScrollEl.style.display    = 'none';
  libCatsBarEl.style.display   = 'none';
  gbPanel.style.display = '';
  libSearchClear.style.display = '';
  browseCatalog(gbBrowseFilter);
}

libSearchEl.addEventListener('focus', () => {
  if(gbPanel && gbPanel.style.display !== 'none') return; // in browse mode, top bar is already active
  const q = libSearchEl.value.trim();
  if(q) return; // has text — input handler covers it
  // No query: show panel with just the online section
  libSearchPanel.style.display = '';
  libScrollEl.style.display    = 'none';
  libCatsBarEl.style.display   = 'none';
  libSearchClear.style.display = '';
  document.getElementById('lsp-local').style.display = 'none';
  document.getElementById('lsp-more').style.display  = 'none';
});

libSearchEl.addEventListener('input', e => {
  clearTimeout(libSearchTimer);
  const q = e.target.value.trim();
  // Browse panel is open: top search bar drives it
  if(gbPanel && gbPanel.style.display !== 'none'){
    libSearchTimer = setTimeout(() => browseCatalog(gbBrowseFilter), 300);
    return;
  }
  if(!q){
    // Keep panel open with only online section when query cleared
    document.getElementById('lsp-local').style.display = 'none';
    document.getElementById('lsp-more').style.display  = 'none';
    return;
  }
  libSearchTimer = setTimeout(() => showSearchPanel(q), 200);
});

libSearchClear.addEventListener('click', () => {
  if(gbPanel && gbPanel.style.display !== 'none'){
    // In browse mode: clear query and re-browse all books
    libSearchEl.value = '';
    browseCatalog(gbBrowseFilter);
    return;
  }
  hideSearchPanel();
});

// Browse button
document.getElementById('lsp-browse-btn').addEventListener('click', openBrowsePanel);

// ── Unified filter bar (level + category)
document.querySelectorAll('.lcat').forEach(btn => {
  btn.addEventListener('click', () => {
    libFilter = btn.dataset.filter;
    document.querySelectorAll('.lcat').forEach(b => b.classList.toggle('on', b === btn));
    renderLib();
  });
});

// ── Logo → return to landing
document.getElementById('logo-btn').addEventListener('click', () => {
  const reader = document.getElementById('reader');
  const player = document.getElementById('player');
  // Only act when reader is visible (user is reading)
  if(reader.style.display === 'none' || !reader.style.display) return;
  synth.cancel(); stopResumeTimer();
  if(kokActive) kokStop();
  S.playing = false; S.paused = false; setIcon(false);
  withVT(() => {
    reader.style.display = 'none';
    player.style.display = 'none';
    document.getElementById('pct-badge').style.display = 'none';
    document.getElementById('chap-tbtn').style.display = 'none';
    document.getElementById('filename').textContent = '未加载';
    document.getElementById('landing').style.display = '';
  });
});

// ── Library open/close
document.getElementById('lib-tbtn').addEventListener('click', () => {
  document.getElementById('library').classList.toggle('open');
  if(!voaLoaded){ voaLoaded=true; loadVoaFeed(); }
});
document.getElementById('lib-open-btn').addEventListener('click', () => {
  document.getElementById('library').classList.add('open');
  if(!voaLoaded){ voaLoaded=true; loadVoaFeed(); }
});
document.getElementById('lib-close').addEventListener('click', () => {
  // Smart back: GB panel → search panel → book list → close library
  if(gbPanel && gbPanel.style.display !== 'none'){
    closeGbPanel();
    const q = libSearchEl.value.trim();
    if(q){ showSearchPanel(q); } else { hideSearchPanel(); }
    return;
  }
  if(libSearchPanel.style.display !== 'none'){
    hideSearchPanel();
    return;
  }
  document.getElementById('library').classList.remove('open');
});

renderLib();



// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const S = {
  sents:[], idx:0,
  playing:false, paused:false,
  speed:1.0, accentUS:true,
  mode:'normal', fontSize:18,
  lineHeight:2.05, textAlign:'left',
  vocab:[], fileName:'',
  srchHits:[], srchIdx:0, srchOpen:false,
  night:false, bilin:false, trans:{}, align:{}, nalign:{},
  curWordEl:null, curWordData:null, wordCs:0,
  selectedVoice:null, savedWords:new Set(),
  kokVoice:'af_heart',  // selected Kokoro neural voice
  chapters:[],  // { title, sentIdx, el }
};
const synth = window.speechSynthesis;
let resumeTimer = null;

function startResumeTimer(){
  stopResumeTimer();
  resumeTimer = setInterval(()=>{
    if(synth.speaking && !synth.paused){ synth.pause(); synth.resume(); }
  }, 14000);
}
function stopResumeTimer(){ clearInterval(resumeTimer); resumeTimer = null; }

// ═══════════════════════════════════════════
//  PERSIST (localStorage)
// ═══════════════════════════════════════════
function saveProg(){
  if(!S.fileName) return;
  localStorage.setItem('rdr_'+S.fileName, JSON.stringify({
    idx:S.idx, speed:S.speed,
    fontSize:S.fontSize, night:S.night, bilin:S.bilin,
    accentUS:S.accentUS, mode:S.mode,
    lineHeight:S.lineHeight, textAlign:S.textAlign,
  }));
  localStorage.setItem('vocab', JSON.stringify(S.vocab));
}
function loadProg(){
  const raw = localStorage.getItem('rdr_'+S.fileName);
  if(raw){
    const d = JSON.parse(raw);
    S.idx        = d.idx        || 0;
    S.speed      = d.speed      || 1.0;
    S.fontSize   = d.fontSize   || 18;
    S.night      = !!d.night;
    S.bilin      = !!d.bilin;
    S.accentUS   = d.accentUS !== undefined ? d.accentUS : true;
    S.mode       = d.mode       || 'normal';
    S.lineHeight = d.lineHeight || 2.05;
    S.textAlign  = d.textAlign  || 'left';
  }
  const v = localStorage.getItem('vocab');
  if(v) try{ S.vocab = JSON.parse(v); }catch(e){}
}
function restoreProg(){
  if(S.idx > 0 && S.idx < S.sents.length){
    setTimeout(()=>{ jump(S.idx); toast(`已恢复到 ${Math.round(S.idx/S.sents.length*100)}% 进度`); }, 400);
  }
}

// ═══════════════════════════════════════════
//  VOICES
// ═══════════════════════════════════════════
let allVoices = [];
function qualityScore(v){
  // iOS hides quality tier in voiceURI (com.apple.voice.enhanced.en-US.Samantha)
  // while name stays plain "Samantha" — score on both.
  const n = (v.name + ' ' + (v.voiceURI || '')).toLowerCase();
  if(n.includes('siri'))     return 10;
  if(n.includes('premium'))  return 9;   // Apple premium neural (Ava, Zoe…)
  if(n.includes('enhanced')) return 8;   // Apple enhanced
  if(n.includes('natural'))  return 5;   // Edge neural voices (same as Azure Neural)
  if(n.includes('compact'))  return 0;
  if(n.includes('google'))   return 1;   // Google TTS — blocked in China
  return 3;
}
function cleanVoiceName(v){
  return v.name
    .replace(/com\.apple\.voice\.(enhanced|compact|premium)\./,'')
    .replace('com.apple.ttsbundle.','')
    .replace('com.apple.eloquence.','')
    .replace(/^en[-_][A-Z]{2}[-_]/,'')
    .replace(/ \(.*?\)/,'').trim();
}
const BLOCK = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|jester|junior|organ|pipe organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox/i;

function populateVoices(){
  allVoices = synth.getVoices();
  const enVoices = allVoices
    .filter(v => v.lang.startsWith('en') && !BLOCK.test(v.name));
  if(!enVoices.length) return;
  // 系统音源只保留 Samantha 作为默认兜底；找不到则取最佳英文音兜底
  const only = enVoices.find(v => /samantha/i.test(v.name))
            || enVoices.slice().sort((a,b)=>qualityScore(b)-qualityScore(a))[0];
  const sel = document.getElementById('sb-voice-select');
  if(!sel) return;
  sel.innerHTML = '';
  const o = document.createElement('option');
  o.value = only.name;
  const flag = only.lang==='en-US'?'🇺🇸':only.lang==='en-GB'?'🇬🇧':'🌐';
  o.textContent = flag+' '+cleanVoiceName(only);
  sel.appendChild(o);
  sel.value = only.name;
  S.selectedVoice = only;
  localStorage.setItem('selectedVoice', only.name);
}
synth.onvoiceschanged = ()=>{ populateVoices(); };
populateVoices();

// ═══════════════════════════════════════════
//  FILE LOADING (from local TXT upload)
// ═══════════════════════════════════════════
// ── Share app
document.getElementById('share-btn').addEventListener('click', async () => {
  const shareData = {
    title: 'Linggo — 免费英文原著阅读器',
    text: '推荐一个免费英文阅读工具 Linggo，57本经典名著免费读，点词查义+TTS跟读+闪卡背单词，完全免费无广告！',
    url: 'https://langhua98.github.io/Linggo/'
  };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch(e) { /* user cancelled */ }
  } else {
    const text = `${shareData.text}\n${shareData.url}`;
    await navigator.clipboard.writeText(text);
    toast('推荐语已复制，粘贴发给朋友吧！');
  }
});

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
dropZone.addEventListener('click', ()=>fileInput.click());
fileInput.addEventListener('change', e=>{ if(e.target.files[0]) readFile(e.target.files[0]); });
dropZone.addEventListener('dragover', e=>{ e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', ()=>dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e=>{
  e.preventDefault(); dropZone.classList.remove('drag');
  const f=e.dataTransfer.files[0];
  if(f&&f.name.endsWith('.txt')) readFile(f);
  else toast('请上传 .txt 格式文件');
});
function readFile(f){
  if(f.size > 50 * 1024 * 1024){ toast('文件过大，请上传 50MB 以内的 TXT 文件'); return; }
  S.fileName=f.name;
  document.getElementById('filename').textContent=f.name;
  const r=new FileReader();
  r.onload=e=>{ loadProg(); buildReader(e.target.result); };
  r.readAsText(f,'UTF-8');
}

// load vocab from localStorage on init
const _sv = localStorage.getItem('vocab');
if(_sv) try{ S.vocab=JSON.parse(_sv); }catch(e){}

// ═══════════════════════════════════════════
//  BUILD READER  —  chunked render + delegation
// ═══════════════════════════════════════════
function splitSents(txt){
  // Protect abbreviation periods so they don't trigger sentence splits.
  // Covers titles, ranks, degrees, months, days, and Latin abbreviations
  // common in classic English literature (Project Gutenberg).
  const ABBR = /\b(Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sr|Jr|Gen|Sgt|Col|Capt|Lt|Maj|Adm|Gov|Sen|Rep|Messrs|Esq|St|Co|Corp|Inc|Dept|Univ|Ave|Blvd|Fig|Figs|Vol|Vols|Ch|Sec|No|Nos|pp|vs|Vs|etc|ie|eg|viz|cf|ca|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Sun|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat)\.(?=\s)/g;
  const safe = txt.replace(ABBR, m => m.slice(0, -1) + '\x01');

  // Step 1: split on sentence-ending punctuation (.!?) and semicolons
  const raw = safe.match(/[^.!?;]+[.!?;]+['""\u201d]?\s*|[^.!?;]+$/g) || [safe];

  // Step 2: further split any chunk longer than 160 chars at a comma
  const MAX = 160;
  const result = [];
  for(const chunk of raw){
    const s = chunk.trim();
    if(!s) continue;
    if(s.length <= MAX){ result.push(s); continue; }
    // Find best comma split point near the middle
    const mid = Math.floor(s.length / 2);
    let best = -1, bestDist = Infinity;
    let i = s.indexOf(',');
    while(i !== -1){
      const dist = Math.abs(i - mid);
      if(dist < bestDist){ bestDist = dist; best = i; }
      i = s.indexOf(',', i + 1);
    }
    if(best > 20 && best < s.length - 20){
      result.push(s.slice(0, best + 1).trim());
      result.push(s.slice(best + 1).trim());
    } else {
      result.push(s);
    }
  }
  // Restore abbreviation periods before returning
  return result.map(s => s.replace(/\x01/g, '.')).filter(s => s.length > 2);
}

// Detect chapter heading — checks ANY sentence, not just standalone paragraphs
function isHeading(text){
  const t = text.trim();
  if(!t || t.length > 90) return false;
  // Common keyword-based headings (most reliable, covers all Gutenberg formats)
  // NOTE: deliberately NOT checking trailing punctuation — "CHAPTER I." ends with "."
  if(/^(chapter|part|section|prologue|epilogue|book|preface|introduction|appendix|interlude|afterword|act\s|adventure|story|tale|letter|volume)/i.test(t)) return true;
  // Standalone Roman numerals  e.g. "I.", "XII", "IV."
  if(/^[IVXLCDM]+\.?\s*$/i.test(t) && t.length <= 10) return true;
  // Standalone Arabic numbers  e.g. "1.", "12"
  if(/^\d+\.?\s*$/.test(t) && t.length <= 5) return true;
  return false;
}

// Build one paragraph element.
// Now checks if FIRST sentence is a heading (not just single-sentence paragraphs).
// Returns DocumentFragment (may contain heading div + para div) or plain Element.
function buildPara(ss, startIdx){
  if(isHeading(ss[0])){
    const frag = document.createDocumentFragment();

    // Heading element
    const h = document.createElement('div');
    h.className = 'para-heading';
    h.textContent = ss[0];
    S.chapters.push({ title: ss[0], sentIdx: startIdx, el: h });
    // Hidden sent span so TTS can start from this heading
    const hsp = document.createElement('span');
    hsp.className = 'sent'; hsp.dataset.i = startIdx;
    hsp.style.display = 'none';
    hsp.textContent = ss[0];
    h.appendChild(hsp);
    frag.appendChild(h);

    // Remaining sentences as a normal paragraph (sub-title or first para)
    if(ss.length > 1){
      const pEl = document.createElement('div');
      pEl.className = 'para';
      ss.slice(1).forEach((s, j) => {
        const sp = document.createElement('span');
        sp.className = 'sent';
        sp.dataset.i = startIdx + 1 + j;
        sp.textContent = s + ' ';
        pEl.appendChild(sp);
      });
      frag.appendChild(pEl);
    }
    return frag;
  }

  // Normal paragraph
  const pEl = document.createElement('div');
  pEl.className = 'para';
  ss.forEach((s, j) => {
    const sp = document.createElement('span');
    sp.className = 'sent';
    sp.dataset.i = startIdx + j;
    sp.textContent = s + ' ';
    pEl.appendChild(sp);
  });
  return pEl;
}

// Inject word spans into a sentence on demand (lazy)
function injectWords(sp){
  if (sp.dataset.words) return;
  sp.dataset.words = '1';
  const i   = +sp.dataset.i;
  const raw = S.sents[i];
  const frag = document.createDocumentFragment();
  let charPos = 0;

  const parts = raw.split(/(\s+)/);
  parts.forEach(part => {
    if (/^\s+$/.test(part)) {
      frag.appendChild(document.createTextNode(part));
      charPos += part.length;
    } else {
      const m = part.match(/^([^a-zA-Z']*)([a-zA-Z']+)([^a-zA-Z']*)$/);
      if (m) {
        if (m[1]) { frag.appendChild(document.createTextNode(m[1])); charPos += m[1].length; }
        const w = document.createElement('span');
        w.className = 'word';
        const clean = m[2].toLowerCase().replace(/^'+|'+$/g,'');
        w.dataset.w = clean;
        w.dataset.charStart = charPos; // ← char offset within sentence
        w.textContent = m[2];
        if (S.savedWords.has(clean)) w.classList.add('saved');
        frag.appendChild(w);
        charPos += m[2].length;
        if (m[3]) { frag.appendChild(document.createTextNode(m[3])); charPos += m[3].length; }
      } else {
        frag.appendChild(document.createTextNode(part));
        charPos += part.length;
      }
    }
  });
  frag.appendChild(document.createTextNode(' '));
  sp.textContent = '';
  sp.appendChild(frag);
}

// ═══════════════════════════════════════════
//  INTERACTION
//  单击单词       → 查词弹窗
//  长按句子 500ms → 从这句开始播放
// ═══════════════════════════════════════════
const area = document.getElementById('content');
let pressTimer = null;
let pressFired = false;
let touchActive = false; // distinguish touch vs mouse
let touchStartX = 0, touchStartY = 0, touchMoved = false;

// ── MOBILE (touch) ──────────────────────────
// Passive touchstart: iOS long-press menu / text-selection callout is already
// suppressed via CSS on #content (-webkit-touch-callout: none; user-select: none),
// so no preventDefault() is needed here — keeps scrolling on the compositor thread.
area.addEventListener('touchstart', function(e){
  const sentEl = e.target.closest('.sent');
  if(!sentEl) return;

  touchActive = true;
  const _t0 = e.touches[0];
  if(_t0){ touchStartX = _t0.clientX; touchStartY = _t0.clientY; }
  touchMoved = false;
  injectWords(sentEl);

  pressFired = false;
  clearTimeout(pressTimer);

  const wordEl = e.target.closest('.word');
  if(!wordEl){
    // Long press on sentence (not a word) → play from here
    pressTimer = setTimeout(()=>{
      pressFired = true;
      const i = +sentEl.dataset.i;
      synth.cancel(); stopResumeTimer();
      S.paused = false; S.playing = false; setIcon(false);
      S.idx = i; jump(i); playCurrent();
    }, 500);
  } else {
    // Long press on a word → jump to its sentence and play
    pressTimer = setTimeout(()=>{
      pressFired = true;
      const i = +sentEl.dataset.i;
      synth.cancel(); stopResumeTimer();
      S.paused = false; S.playing = false; setIcon(false);
      S.idx = i; jump(i); playCurrent();
    }, 500);
  }
}, { passive: true });

area.addEventListener('touchmove', (e)=>{
  const t = e.touches[0];
  if(t && (Math.abs(t.clientX - touchStartX) > 10 || Math.abs(t.clientY - touchStartY) > 10)){
    touchMoved = true;
    clearTimeout(pressTimer); // cancel long-press once it's clearly a scroll
  }
}, { passive: true });

area.addEventListener('touchend', function(e){
  clearTimeout(pressTimer);
  touchActive = true;
  if(!pressFired && !touchMoved){
    // 用 elementFromPoint 而非 e.target：
    // touchstart 时 injectWords 重写了 DOM，e.target 还是旧的 .sent 节点，
    // elementFromPoint 拿到的才是重写后实际在手指下的 .word span
    const touch = e.changedTouches[0];
    const sentEl = e.target.closest('.sent');
    if(sentEl) injectWords(sentEl);
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const wordEl = el?.closest('.word');
    if(wordEl) onWordClick(wordEl).catch(()=>{});
  }
  pressFired = false;
  setTimeout(()=>{ touchActive = false; }, 300);
}, { passive: true });

area.addEventListener('touchcancel', ()=>{
  clearTimeout(pressTimer); pressFired = false;
}, { passive: true });

// ── DESKTOP (mouse) ──────────────────────────
area.addEventListener('mousedown', e=>{
  if(touchActive) return;
  const sentEl = e.target.closest('.sent');
  if(sentEl) injectWords(sentEl);

  pressFired = false;
  clearTimeout(pressTimer);
  const wordEl = e.target.closest('.word');
  if(sentEl && !wordEl){
    pressTimer = setTimeout(()=>{
      pressFired = true;
      const i = +sentEl.dataset.i;
      synth.cancel(); stopResumeTimer();
      S.paused = false; S.playing = false; setIcon(false);
      S.idx = i; jump(i); playCurrent();
    }, 500);
  } else if(sentEl && wordEl){
    // Long press on word → jump to its sentence
    pressTimer = setTimeout(()=>{
      pressFired = true;
      const i = +sentEl.dataset.i;
      synth.cancel(); stopResumeTimer();
      S.paused = false; S.playing = false; setIcon(false);
      S.idx = i; jump(i); playCurrent();
    }, 500);
  }
});
area.addEventListener('mouseup',   ()=> clearTimeout(pressTimer));
area.addEventListener('mousemove', ()=> clearTimeout(pressTimer));

area.addEventListener('click', e=>{
  if(touchActive || pressFired){ pressFired = false; return; }
  const wordEl = e.target.closest('.word');
  if(wordEl) onWordClick(wordEl).catch(()=>{});
});

// Desktop hover → inject words
area.addEventListener('mouseover', e=>{
  const sentEl = e.target.closest('.sent');
  if(sentEl) injectWords(sentEl);
});

// Block browser context menu and text selection
area.addEventListener('contextmenu', e=> e.preventDefault());
area.addEventListener('selectstart',  e=> e.preventDefault());




function buildReader(raw){
  const paras = raw.split(/\n\s*\n/).map(p => p.replace(/\s+/g,' ').trim()).filter(p => p.length > 10);
  S.sents = []; S.trans = {}; S.align = {}; S.nalign = {}; S.chapters = [];
  S.savedWords = new Set(S.vocab.map(v => v.word));
  area.innerHTML = '';

  // Parse ALL sentences first (fast, no DOM)
  const paraGroups = [];
  paras.forEach(para => {
    const ss = splitSents(para);
    if (!ss.length) return;
    const startIdx = S.sents.length;
    ss.forEach(s => S.sents.push(s));
    paraGroups.push({ ss, startIdx });
  });

  // Render in chunks of 30 paragraphs using setTimeout
  // so the browser doesn't freeze on large books
  const CHUNK = 30;
  let rendered = 0;

  function renderChunk() {
    const end = Math.min(rendered + CHUNK, paraGroups.length);
    const frag = document.createDocumentFragment();
    for (let i = rendered; i < end; i++) {
      frag.appendChild(buildPara(paraGroups[i].ss, paraGroups[i].startIdx));
    }
    area.appendChild(frag);
    rendered = end;
    if (rendered < paraGroups.length) {
      setTimeout(renderChunk, 0); // yield to browser between chunks
    } else {
      // All done — restore position + show chapter button if chapters found
      restoreProg();
      renderChapters();
      const chapBtn = document.getElementById('chap-tbtn');
      chapBtn.style.display = S.chapters.length ? '' : 'none';
      applyBilin(); // set up observer if bilin mode was on before book loaded
      _kokWarm();   // pre-synthesize the starting sentence so play is instant
    }
  }

  applyFont(); applyNight(); applyLineHeight(); applyTextAlign();
  document.getElementById('landing').style.display = 'none';
  document.getElementById('reader').style.display = 'block';
  document.getElementById('player').style.display = 'block';
  document.getElementById('pct-badge').style.display = '';
  applySpeed(S.speed);   renderVoc();

  renderChunk(); // start chunked rendering
}

// ═══════════════════════════════════════════
//  CHAPTER TOC
// ═══════════════════════════════════════════
function renderChapters(){
  const list = document.getElementById('chap-list');
  if(!S.chapters.length){
    list.innerHTML = '<div class="chap-empty">本书未检测到章节标题。<br>支持 Chapter / Part / I. 等格式。</div>';
    return;
  }
  list.innerHTML = S.chapters.map((c,i) => `
    <div class="chap-item" data-i="${i}">
      <span class="chap-num">${i+1}</span>
      <span class="chap-name">${c.title}</span>
    </div>`).join('');
  list.querySelectorAll('.chap-item').forEach(item => {
    item.addEventListener('click', ()=>{
      const c = S.chapters[+item.dataset.i];
      if(!c) return;
      // Jump to sentence and scroll heading into view
      jump(c.sentIdx);
      // Subtle page-turn flip on the reader content
      const _ct = document.getElementById('content');
      if(_ct){ _ct.classList.remove('flip'); void _ct.offsetWidth; _ct.classList.add('flip'); }
      setTimeout(()=> c.el.scrollIntoView({behavior:'smooth', block:'start'}), 80);
      closeChapPanel();
    });
  });
}
function openChapPanel(){
  document.getElementById('chap-panel').classList.add('open');
  document.getElementById('overlay').classList.add('vis');
  // Highlight current chapter
  const list = document.getElementById('chap-list');
  list.querySelectorAll('.chap-item').forEach((item,i) => {
    const c = S.chapters[i];
    const next = S.chapters[i+1];
    const active = c && S.idx >= c.sentIdx && (!next || S.idx < next.sentIdx);
    item.classList.toggle('cur', active);
    if(active) item.scrollIntoView({block:'nearest'});
  });
}
function closeChapPanel(){
  document.getElementById('chap-panel').classList.remove('open');
  document.getElementById('overlay').classList.remove('vis');
}
document.getElementById('chap-tbtn').addEventListener('click', openChapPanel);
document.getElementById('chap-close').addEventListener('click', closeChapPanel);

// ═══════════════════════════════════════════
//  SENTENCE TRANSLATE (called from sidebar or future button)
// ═══════════════════════════════════════════

async function onSentTranslate(i, sp){
  if (S.mode === 'immersive') return;
  if (S.bilin) return; // bilin mode already shows all translations
  injectWords(sp);
  const nx = sp.nextElementSibling;
  if (nx && nx.classList.contains('tl-line')){ nx.remove(); return; }
  if (S.trans[i]){ showTL(sp, S.trans[i]); return; }
  const tl = document.createElement('span');
  tl.className = 'tl-line'; tl.textContent = '翻译中…'; sp.after(tl);
  const res = await translate(S.sents[i]);
  S.trans[i] = res; tl.textContent = res;
}
function showTL(sp, txt){
  const tl = document.createElement('span');
  tl.className = 'tl-line'; tl.textContent = txt; sp.after(tl);
}
// Translation cache: avoid re-fetching same sentences within session
const TRANS_CACHE = (() => {
  let mem = {};
  try { mem = JSON.parse(sessionStorage.getItem('tl_cache') || '{}'); } catch(e) {}
  return {
    get: k => mem[k],
    set: (k, v) => {
      const keys = Object.keys(mem);
      if(keys.length >= 300) delete mem[keys[0]]; // FIFO 上限 300 条
      mem[k] = v;
      try { sessionStorage.setItem('tl_cache', JSON.stringify(mem)); } catch(e) {}
    }
  };
})();

function fetchTimed(url, ms = 6000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

async function translate(txt) {
  const cacheKey = txt.slice(0, 120);
  const hit = TRANS_CACHE.get(cacheKey);
  if (hit) return hit;

  const q = encodeURIComponent(txt.slice(0, 500));

  // Source 1: Google Translate (unofficial, most reliable)
  try {
    const r = await fetchTimed(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`);
    const d = await r.json();
    const result = d[0]?.map(s => s?.[0] || '').join('').trim();
    if (result) { TRANS_CACHE.set(cacheKey, result); return result; }
  } catch(e) {}

  // Source 2: MyMemory
  try {
    const r = await fetchTimed(`https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh`);
    const d = await r.json();
    if (d.responseStatus === 200 && d.responseData?.translatedText) {
      const result = d.responseData.translatedText;
      TRANS_CACHE.set(cacheKey, result); return result;
    }
  } catch(e) {}

  // Source 3: Lingva (open-source Google Translate frontend)
  try {
    const r = await fetchTimed(`https://lingva.lunar.icu/api/v1/en/zh/${encodeURIComponent(txt.slice(0, 300))}`);
    const d = await r.json();
    if (d.translation) { TRANS_CACHE.set(cacheKey, d.translation); return d.translation; }
  } catch(e) {}

  return '[翻译失败，请检查网络]';
}

// ═══════════════════════════════════════════
//  BILINGUAL MODE
//  IntersectionObserver lazily translates each sentence as it scrolls
//  into view — never pre-fetches the whole book.
// ═══════════════════════════════════════════
let _bilinObs = null;

function _bilinTranslateSent(sp){
  if(sp.style.display === 'none') return; // hidden heading spans
  const nx = sp.nextElementSibling;
  if(nx && nx.classList.contains('tl-line')) return; // already translated
  const i = +sp.dataset.i;
  const tl = document.createElement('span');
  tl.className = 'tl-line';
  tl.textContent = '…';
  sp.after(tl);
  if(S.trans[i]){
    tl.textContent = S.trans[i];
  } else {
    translate(S.sents[i]).then(res => {
      S.trans[i] = res;
      tl.textContent = res;
    }).catch(() => { tl.remove(); });
  }
}

function applyBilin(){
  const content = document.getElementById('content');
  // Always disconnect first to avoid observing stale/removed elements
  if(_bilinObs){ _bilinObs.disconnect(); _bilinObs = null; }
  const btn = document.getElementById('bilin-toggle');
  if(btn) btn.classList.toggle('on', S.bilin);
  if(S.bilin){
    content.classList.add('bilin');
    _bilinObs = new IntersectionObserver(entries => {
      for(const e of entries){
        if(e.isIntersecting) _bilinTranslateSent(e.target);
      }
    }, { rootMargin: '0px 0px 300px 0px' }); // 300px pre-load ahead
    content.querySelectorAll('.sent').forEach(sp => _bilinObs.observe(sp));
  } else {
    content.classList.remove('bilin');
    _cnClearHl();
  }
  if(typeof _syncNalignRow === 'function') _syncNalignRow();
}

// ═══════════════════════════════════════════
//  NEURAL ALIGNMENT  神经词对齐（可选 · 高精度）
//  开启后懒加载一个 ~112 MB 多语言 MiniLM 模型（WASM，浏览器内推理），
//  用上下文向量相似度做英中词对齐，准确度远高于词典查表。
//  未开启 / 加载中 / 失败时自动回退到本地词典对齐。模型在独立 Worker 中运行。
// ═══════════════════════════════════════════
const NALIGN = (() => {
  let worker = null, ready = false, loading = null, msgId = 0;
  const pend = new Map();          // msgId → 句子下标
  const inflight = new Set();      // 正在对齐的句子下标
  let enabled = localStorage.getItem('nalign') === '1';

  function _spawn(){
    if(ready) return Promise.resolve(true);
    if(loading) return loading;
    loading = new Promise((resolve, reject) => {
      let lastPct = -20;
      try { worker = new Worker('/Linggo/align-worker.js', { type: 'module' }); }
      catch(e){ loading = null; reject(e); return; }
      worker.onerror = () => { if(!ready){ loading = null; reject(new Error('align worker failed')); } };
      worker.onmessage = (e) => {
        const m = e.data;
        if(m.type === 'progress'){
          const pct = Math.floor(m.progress);
          if(pct >= lastPct + 20){ lastPct = pct; toast(`正在下载词对齐模型 ${pct}%`); }
        } else if(m.type === 'ready'){
          ready = true; toast('神经词对齐已就绪 ✓'); resolve(true);
        } else if(m.type === 'result'){
          const i = pend.get(m.id); pend.delete(m.id); inflight.delete(i);
          S.nalign[i] = m.align;
          // 若结果属当前正在朗读的句子，立即用新对齐重绘高亮
          if(i === _curHlIdx && _curHlCs >= 0) _cnAlignHighlight(i, _curHlCs);
        } else if(m.type === 'error'){
          const i = pend.get(m.id); pend.delete(m.id); if(i != null) inflight.delete(i);
          if(m.id == null && !ready){ loading = null; reject(new Error(m.message)); }
        }
      };
      worker.postMessage({ type: 'load' });
    });
    return loading;
  }

  function request(i){
    if(!enabled || i < 0) return;
    if(S.nalign[i] || inflight.has(i)) return;     // 已对齐 / 排队中
    const en = S.sents[i], zh = S.trans[i];
    if(!en || zh == null) return;                  // 译文未就绪
    inflight.add(i);
    _spawn().then(() => {
      const id = ++msgId; pend.set(id, i);
      worker.postMessage({ type: 'align', id, i, en, zh });
    }).catch(() => { inflight.delete(i); });
  }

  function setEnabled(v){
    enabled = !!v;
    localStorage.setItem('nalign', enabled ? '1' : '0');
    if(enabled){
      S.nalign = {};                               // 清掉旧词典结果，改用神经对齐
      _spawn().catch(() => toast('词对齐模型加载失败，已回退词典'));
      if(_curHlIdx >= 0) request(_curHlIdx);
    }
  }

  return { request, setEnabled, isEnabled: () => enabled };
})();

// ═══════════════════════════════════════════
//  WORD ALIGNMENT  词对齐（词典法 · 默认 / 离线兜底）
//  本地词典（CET4 + CET6 + Ogden850 + ECDICT 12k）把英文词映射到中文义项，
//  在整句译文里定位该义项的字符位置 → 朗读到哪个英文词，对应中文同步高亮。
//  纯前端、无后端、零延迟；开启"神经词对齐"后 _buildAlign 改用 NALIGN 结果。
// ═══════════════════════════════════════════
// 高频基础实词补充表——CET/Ogden 多未收录，但阅读文本里最常见
const _LEX_BASE = {
  live:'住；生活；活着', life:'生活；生命', home:'家；家庭', house:'房子；屋',
  course:'课程；过程', know:'知道；认识', begin:'开始', beginning:'开始；开端',
  end:'结束；末端', start:'开始', come:'来', go:'去；走', see:'看；看见',
  look:'看；瞧', watch:'看；观察', think:'想；认为', say:'说',
  tell:'告诉；讲', talk:'说话；谈', speak:'说；讲', ask:'问；要求', answer:'回答',
  find:'找到；发现', give:'给', take:'拿；取', get:'得到', make:'做；制造',
  want:'想要', need:'需要', feel:'感觉；觉得', become:'变成；成为', leave:'离开',
  grow:'生长；成长', keep:'保持；保留', let:'让；允许', turn:'转；变', call:'叫；打电话',
  work:'工作', play:'玩；演奏', run:'跑；运行', walk:'走；步行', move:'移动',
  hear:'听见', read:'读', write:'写', open:'打开', close:'关闭', stand:'站；立',
  sit:'坐', lie:'躺；说谎', sleep:'睡', eat:'吃', drink:'喝', love:'爱', like:'喜欢',
  hate:'恨；讨厌', hope:'希望', wish:'希望；愿', remember:'记得', forget:'忘记',
  day:'天；白天', night:'夜晚', morning:'早晨', time:'时间', year:'年', hour:'小时',
  man:'男人；人', woman:'女人', child:'孩子', boy:'男孩', girl:'女孩', friend:'朋友',
  mother:'母亲；妈妈', father:'父亲；爸爸', hand:'手', eye:'眼睛', face:'脸；面孔',
  head:'头', heart:'心', way:'路；方法', thing:'事物；东西', world:'世界',
  room:'房间', door:'门', window:'窗', water:'水', fire:'火', light:'光；灯',
  word:'词；话', name:'名字', story:'故事', book:'书', voice:'声音', sound:'声音',
  lovely:'可爱的；美好的', sweet:'甜的；可爱的', good:'好的', great:'伟大的；很好的',
  little:'小的；一点', old:'老的；旧的', young:'年轻的', long:'长的', short:'短的',
  high:'高的', low:'低的', small:'小的', large:'大的', big:'大的', happy:'快乐的',
  sad:'悲伤的', kind:'善良的；种类', dark:'黑暗的', bright:'明亮的', quiet:'安静的',
  beautiful:'美丽的', pretty:'漂亮的', strange:'奇怪的', true:'真的', real:'真实的',
  chief:'主要的；首领', whole:'整个的', full:'满的', mind:'头脑；介意', romantic:'浪漫的',
};

let _LEX = null;
function _buildLex(){
  if(_LEX) return _LEX;
  _LEX = new Map();
  const add = arr => {
    if(!Array.isArray(arr)) return;
    for(const e of arr){ if(e && e.w && !_LEX.has(e.w)) _LEX.set(e.w, e.cn); }
  };
  if(typeof CET4     !== 'undefined') add(CET4);
  if(typeof CET6     !== 'undefined') add(CET6);
  if(typeof OGDEN850 !== 'undefined') add(OGDEN850);
  if(typeof ECDICT   !== 'undefined') add(ECDICT);
  for(const w in _LEX_BASE){ if(!_LEX.has(w)) _LEX.set(w, _LEX_BASE[w]); }
  return _LEX;
}

// 英文词 → 中文义项原文（含简单词形还原）
function _lexGet(w){
  const L = _buildLex();
  if(L.has(w)) return L.get(w);
  const cands = [];
  if(/ies$/.test(w)) cands.push(w.replace(/ies$/, 'y'));
  if(/es$/.test(w))  cands.push(w.replace(/es$/, ''));
  if(/s$/.test(w))   cands.push(w.replace(/s$/, ''));
  if(/ed$/.test(w))  { cands.push(w.replace(/ed$/, '')); cands.push(w.replace(/ed$/, 'e')); }
  if(/ing$/.test(w)) { cands.push(w.replace(/ing$/, '')); cands.push(w.replace(/ing$/, 'e')); }
  if(/d$/.test(w))   cands.push(w.replace(/d$/, ''));
  if(/er$/.test(w))  cands.push(w.replace(/er$/, ''));
  if(/ly$/.test(w))  cands.push(w.replace(/ly$/, ''));
  for(const c of cands){ if(L.has(c)) return L.get(c); }
  return null;
}

// 把义项串拆成"按词义先后排序"的候选中文片段（主词义优先，非按长度）
// "甜的；可爱的" → ["甜的","甜","可爱的","可爱"]，确保主词义先匹配
function _glossSenses(cn){
  const out = [];
  for(const sense of cn.split(/[；;]/).map(s => s.trim()).filter(Boolean)){
    for(let q of sense.split(/[，,、/]/).map(s => s.trim()).filter(Boolean)){
      q = q.replace(/[（(][^)）]*[)）]/g, '').trim(); // 去括号注释
      if(!q) continue;
      out.push(q);
      const s = q.replace(/[的地得了着]$/, ''); // 去虚词尾，提升匹配率
      if(s && s !== q) out.push(s);
    }
  }
  return [...new Set(out)];
}

// 功能词/代词不参与对齐——高亮它们只会添乱
const _STOP = new Set(('a an the of to and or but nor in on at with for as by from into onto ' +
  'is am are was were be been being do does did have has had will would shall should can could ' +
  'may might must that this these those it its he she they we you i me him her them us his their ' +
  'my your our not no so if then than too very there here what which who whom whose when where ' +
  'why how all any some each every out up down over under off again about above below').split(' '));

// 提取英文词及其在句中的字符起点（与 injectWords 一致）
function _enWords(sent){
  const out = []; let pos = 0;
  for(const part of sent.split(/(\s+)/)){
    if(/^\s+$/.test(part)){ pos += part.length; continue; }
    const m = part.match(/[a-zA-Z']+/);
    if(m){
      const w = m[0].toLowerCase().replace(/^'+|'+$/g, '');
      out.push({ w, cs: pos + part.indexOf(m[0]) });
    }
    pos += part.length;
  }
  return out;
}

// 整句预对齐：英文词 → 中文译文字符区间，带"已占用"约束，避免抢词
function _buildAlign(i){
  if(S.nalign[i]) return S.nalign[i];          // 神经对齐结果优先（更准）
  if(S.align[i] !== undefined) return S.align[i];
  const T = S.trans[i];
  if(T == null) return undefined;            // 译文未就绪，先不缓存
  const res = [];
  const claimed = [];                         // 已占用的中文区间 [start,end)
  const overlaps = (a, b) => claimed.some(r => a < r[1] && b > r[0]);
  let lastEnd = 0;
  for(const { w, cs } of _enWords(S.sents[i])){
    if(_STOP.has(w)) continue;
    const gl = _lexGet(w); if(!gl) continue;
    let chosen = null;
    for(const g of _glossSenses(gl)){
      if(!g) continue;
      // 优先取 lastEnd 之后的未占用位置（单调，读起来从左到右）
      let idx = T.indexOf(g, lastEnd);
      while(idx >= 0 && overlaps(idx, idx + g.length)) idx = T.indexOf(g, idx + 1);
      if(idx < 0){                            // 退而求其次：全句找未占用位置
        idx = T.indexOf(g);
        while(idx >= 0 && overlaps(idx, idx + g.length)) idx = T.indexOf(g, idx + 1);
      }
      if(idx >= 0){ chosen = [idx, idx + g.length]; break; }
    }
    if(chosen){ claimed.push(chosen); lastEnd = chosen[1]; res.push({ en: cs, cs: chosen[0], ce: chosen[1] }); }
  }
  res.sort((a, b) => a.en - b.en);
  S.align[i] = res;
  return res;
}

let _cnHlEl = null, _cnHlIdx = -1;
function _cnClearHl(){
  if(_cnHlEl && S.trans[_cnHlIdx] != null) _cnHlEl.textContent = S.trans[_cnHlIdx];
  _cnHlEl = null; _cnHlIdx = -1;
}

let _curHlIdx = -1, _curHlCs = -1;     // 当前正在朗读的句/词，供异步对齐就绪后重绘
// 朗读到英文词（句内字符起点 enCs，属第 globalIdx 句）时，高亮对应中文字
function _cnAlignHighlight(globalIdx, enCs){
  _curHlIdx = globalIdx; _curHlCs = enCs;
  NALIGN.request(globalIdx);            // 高精度模式下按需触发神经对齐
  NALIGN.request(globalIdx + 1);        // 预取下一句，朗读到时已就绪
  const T = S.trans[globalIdx];
  const tl = document.querySelector(`.sent[data-i="${globalIdx}"] + .tl-line`);
  if(T == null || !tl){ _cnClearHl(); return; }
  const align = _buildAlign(globalIdx);
  _cnClearHl();
  if(!align || !align.length) return;
  const hits = align.filter(a => a.en === enCs);   // 一词可对多个非连续中文区间
  if(!hits.length) return;
  hits.sort((a, b) => a.cs - b.cs);
  let html = '', p = 0;
  for(const h of hits){
    if(h.cs < p) continue;                          // 跳过重叠区间
    html += _esc(T.slice(p, h.cs)) + '<span class="cn-tts">' + _esc(T.slice(h.cs, h.ce)) + '</span>';
    p = h.ce;
  }
  html += _esc(T.slice(p));
  tl.innerHTML = html;
  _cnHlEl = tl; _cnHlIdx = globalIdx;
}

// ═══════════════════════════════════════════
//  WORD CLICK → DICTIONARY  (dynamic popup)
// ═══════════════════════════════════════════
const wpop = document.getElementById('wpop');

const POS_ZH = {
  noun:'名词', verb:'动词', adjective:'形容词', adverb:'副词',
  pronoun:'代词', preposition:'介词', conjunction:'连词',
  interjection:'感叹词', article:'冠词', determiner:'限定词',
};

function positionPopup(wordEl){
  const rect    = wordEl.getBoundingClientRect();
  const vh      = window.innerHeight;
  const GAP     = 38;
  const TOPBAR  = 54;
  const playerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--player-h')) || 196;
  wpop.style.top    = 'auto';
  wpop.style.bottom = 'auto';
  if(rect.top < vh * 0.52){
    // word in upper half → popup below
    const below = rect.bottom + GAP;
    const max   = vh - playerH - 16;
    wpop.style.top = Math.min(below, max - 260) + 'px';
    wpop.classList.replace('from-above','from-below');
    wpop.classList.add('from-below');
  } else {
    // word in lower half → popup above
    const above = vh - rect.top + GAP;
    const max   = vh - TOPBAR - 16;
    wpop.style.bottom = Math.min(above, max - 260) + 'px';
    wpop.classList.replace('from-below','from-above');
    wpop.classList.add('from-above');
  }
}

async function onWordClick(el){
  const word = el.dataset.w.replace(/[^a-z]/g,'');
  if(!word || word.length < 2) return;

  document.querySelectorAll('.word.active').forEach(w => w.classList.remove('active'));
  el.classList.add('active');

  S.curWordEl   = el;
  const sentEl  = el.closest('.sent');
  const sentText = sentEl ? S.sents[+sentEl.dataset.i] || '' : '';
  S.curWordData = { word, sent: sentText, sentIdx: sentEl ? +sentEl.dataset.i : -1 };

  // header
  document.getElementById('wp-word').textContent = word;
  document.getElementById('wp-ph').textContent   = '';
  const posEl = document.getElementById('wp-pos');
  posEl.style.display = 'none';

  // meaning placeholder
  const meaningEl = document.getElementById('wp-meaning');
  meaningEl.textContent = '…';
  meaningEl.className   = 'wp-meaning loading';

  // context excerpt from current playing sentence
  const isPlaying = S.playing || S.paused;
  const ctxIdx    = isPlaying ? S.idx : S.curWordData.sentIdx;
  const ctxFull   = (S.sents[ctxIdx] || sentText).trim();
  const esc       = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchPos  = ctxFull.search(new RegExp('\\b' + esc + '\\b', 'i'));
  const WIN = 110;
  let excerpt = ctxFull;
  if(ctxFull.length > WIN){
    const center = matchPos >= 0 ? matchPos : Math.floor(ctxFull.length/2);
    let s = Math.max(0, center - WIN/2);
    let e = Math.min(ctxFull.length, s + WIN);
    s = Math.max(0, e - WIN);
    while(s > 0 && ctxFull[s] !== ' ') s--;
    while(e < ctxFull.length && ctxFull[e] !== ' ') e++;
    excerpt = (s>0?'…':'') + ctxFull.slice(s,e).trim() + (e<ctxFull.length?'…':'');
  }
  document.getElementById('wp-context').innerHTML =
    excerpt.replace(new RegExp('\\b('+esc+')\\b','gi'),'<strong>$1</strong>');

  // position then show
  positionPopup(el);
  _stopWordAudio();
  wpop.classList.add('vis');
  if(_licons && _licons.learn) _licons.learn.goToAndStop(0, true);   // reset heart to empty

  // async: dictionary → POS + meaning in Chinese
  try{
    const r = await fetch(
      'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)
    );
    if(!r.ok) throw new Error('dict ' + r.status);
    const entry = (await r.json())[0];
    if(!entry) throw new Error('no entry');

    const ph = entry.phonetics?.find(p => p.text)?.text || '';
    const au = entry.phonetics?.find(p => p.audio?.length > 0)?.audio || '';
    document.getElementById('wp-ph').textContent = ph;
    wpop._audio = au;

    const rawPos = entry.meanings?.[0]?.partOfSpeech || '';
    const zhPos  = POS_ZH[rawPos] || rawPos;
    if(zhPos){ posEl.textContent = zhPos; posEl.style.display = ''; }

    // 直接翻译单词本身（与整句翻译同源 = Google 翻译），简洁不啰嗦
    const zh = await translate(word);
    if(document.getElementById('wp-word').textContent === word){
      meaningEl.textContent = zh;
      meaningEl.className   = 'wp-meaning';
      wpop._meaning = zh;
    }
  }catch{
    // 词典 API 挂掉也照样给翻译，保证有中文释义
    try{
      const zh = await translate(word);
      if(document.getElementById('wp-word').textContent === word){
        meaningEl.textContent = zh;
        wpop._meaning = zh;
      }
    }catch{ meaningEl.textContent = '—'; }
    meaningEl.className = 'wp-meaning';
  }
}

document.getElementById('wp-close').addEventListener('click', () => {
  _stopWordAudio();
  wpop.classList.remove('vis');
  document.querySelectorAll('.word.active').forEach(w => w.classList.remove('active'));
});
document.getElementById('wp-spk').addEventListener('click', () => {
  playWordAudio(document.getElementById('wp-word').textContent, wpop._audio);
});
document.getElementById('wp-copy').addEventListener('click', () => {
  const word = document.getElementById('wp-word').textContent;
  navigator.clipboard?.writeText(word).then(()=> toast(`已复制 "${word}"`)).catch(()=> toast('复制失败'));
});
document.getElementById('wp-learn').addEventListener('click', () => {
  const word = S.curWordData?.word; if(!word) return;
  addVocab(word, wpop._meaning||'');
  toast('「'+word+'」已加入生词本');
  wpop.classList.remove('vis');
  document.querySelectorAll('.word.active').forEach(w=>w.classList.remove('active'));
});
document.getElementById('wp-play').addEventListener('click', () => {
  playWordAudio(document.getElementById('wp-word').textContent, wpop._audio);
});
document.addEventListener('click', e => {
  if(!wpop.contains(e.target) && !e.target.classList.contains('word')){
    _stopWordAudio();
    wpop.classList.remove('vis');
    document.querySelectorAll('.word.active').forEach(w=>w.classList.remove('active'));
  }
});
// ── Word-card audio: one channel so a new play always stops the previous one
//    (no residual overlap); priority Kokoro neural → dictionary MP3 → system.
//    Uses a dedicated <audio> element (separate from the reading player's
//    _kokAudioEl) so word playback never disrupts sentence reading.
let _wordAudioEl = null;
let _wordSeq = 0;
let _wordUnlocked = false;

function _stopWordAudio(){
  _wordSeq++;                                    // invalidate any in-flight async play
  if(_wordAudioEl){ try{ _wordAudioEl.pause(); }catch(e){} }
  if(!S.playing && !S.paused){ try{ window.speechSynthesis.cancel(); }catch(e){} }
}

async function playWordAudio(word, mp3){
  const mySeq = ++_wordSeq;
  if(_wordAudioEl){ try{ _wordAudioEl.pause(); }catch(e){} }
  if(!S.playing && !S.paused){ try{ window.speechSynthesis.cancel(); }catch(e){} }
  if(!_wordAudioEl){
    _wordAudioEl = new Audio();
    _wordAudioEl.setAttribute('playsinline','');
  }
  if(!_wordUnlocked){                            // bless the element inside the click gesture (iOS)
    _wordUnlocked = true;
    try{
      _wordAudioEl.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQAEAAgAZGF0YQIAAAAA';
      _wordAudioEl.play().catch(()=>{});
    }catch(e){}
  }
  const playUrl = async (url, rate) => {
    if(_wordSeq !== mySeq) return false;
    try{
      _wordAudioEl.pause();
      _wordAudioEl.preservesPitch = _wordAudioEl.mozPreservesPitch = _wordAudioEl.webkitPreservesPitch = true;
      _wordAudioEl.playbackRate = rate;
      _wordAudioEl.src = url;
      await _wordAudioEl.play();
      return true;
    }catch(e){ return false; }
  };
  // 1) Kokoro neural — priority when enabled
  if(kokActive && kokTTSReady && KOK_SERVER_URL !== 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space'){
    const url = await Promise.race([
      _kokServerSynth(word).catch(()=>null),
      new Promise(r => setTimeout(()=>r(null), 3500)),   // don't wait on a cold server
    ]);
    if(_wordSeq !== mySeq) return;                       // a newer word was clicked → abandon
    if(url && await playUrl(url, 0.95)) return;
  }
  // 2) Dictionary MP3
  if(mp3 && _wordSeq === mySeq && await playUrl(mp3, 1)) return;
  // 3) System voice fallback
  if(_wordSeq !== mySeq) return;
  const u = new SpeechSynthesisUtterance(word);
  u.lang = S.accentUS ? 'en-US' : 'en-GB'; u.rate = 0.85;
  try{ window.speechSynthesis.cancel(); }catch(e){}
  window.speechSynthesis.speak(u);
}

// ═══════════════════════════════════════════
//  VOCAB
// ═══════════════════════════════════════════
function addVocab(word, meaning){
  if(!word||word.length<2||S.vocab.some(v=>v.word===word)) return;
  const item = {word, meaning, sent:S.curWordData?.sent||'', time:Date.now()};
  S.vocab.push(item);
  S.savedWords.add(word);
  area.querySelectorAll(`.word[data-w="${word}"]`).forEach(el=>el.classList.add('saved'));
  renderVoc(); saveProg(); toast(`已收藏 "${word}"`);
  cloudAddVocab(item); // 云端同步（静默）
}
const VOC_PAGE = 100; // 单次最多渲染条数
function _esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function renderVoc(){
  const q = (document.getElementById('voc-search')?.value || '').trim().toLowerCase();
  const list = document.getElementById('voc-list');
  const filtered = q
    ? S.vocab.filter(v => v.word.toLowerCase().includes(q) || (v.meaning||'').toLowerCase().includes(q))
    : S.vocab;
  document.getElementById('voc-ct').textContent = q
    ? `${filtered.length}/${S.vocab.length} 词`
    : S.vocab.length + ' 词';
  if(!filtered.length){
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:48px 0;color:var(--text-3);font-size:14px;';
    empty.textContent = q ? `未找到「${q}」` : '';
    if(!q) empty.innerHTML = '点击单词后点「收藏」<br>或长按单词快速添加';
    list.innerHTML = ''; list.appendChild(empty);
    return;
  }
  const show = filtered.slice(0, VOC_PAGE);
  list.innerHTML = show.map(v => `
    <div class="vi">
      <div class="vi-w">${_esc(v.word)}</div>
      ${v.meaning ? `<div class="vi-m">${_esc(v.meaning.slice(0,80))}</div>` : ''}
      ${v.sent ? `<div class="vi-s">${_esc(v.sent.trim().slice(0,100))}…</div>` : ''}
      <div class="vi-row">
        <span class="vi-d">${new Date(v.time).toLocaleDateString('zh-CN')}</span>
        <button class="vi-del" data-w="${_esc(v.word)}">🗑</button>
      </div>
    </div>`).join('');
  if(filtered.length > VOC_PAGE){
    list.innerHTML += `<div style="text-align:center;padding:10px;color:var(--text-3);font-size:12px;">共 ${filtered.length} 词，已显示前 ${VOC_PAGE} 条，输入搜索可快速定位</div>`;
  }
  list.querySelectorAll('.vi-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.w;
      const idx = S.vocab.findIndex(x => x.word === w);
      if(idx === -1) return;
      S.vocab.splice(idx, 1);
      document.querySelectorAll(`.word[data-w="${w}"]`).forEach(el => el.classList.remove('saved'));
      cloudDeleteVocab(w);
      renderVoc(); saveProg();
    });
  });
}
document.getElementById('voc-tbtn').addEventListener('click',()=>{ document.getElementById('voc').classList.add('open'); document.getElementById('overlay').classList.add('vis'); renderVoc(); });
document.getElementById('voc-close').addEventListener('click',closeVoc);
document.getElementById('voc-search').addEventListener('input', renderVoc);
document.getElementById('overlay').addEventListener('click', ()=>{
  closeVoc();
  closeSidebar();
  closeChapPanel();
});
function closeVoc(){ document.getElementById('voc').classList.remove('open'); document.getElementById('overlay').classList.remove('vis'); closeSidebar(); }
document.getElementById('exp-txt').addEventListener('click',()=>dl('vocab.txt',S.vocab.map(v=>`${v.word}\t${v.meaning}`).join('\n'),'text/plain'));
document.getElementById('exp-json').addEventListener('click',()=>dl('vocab.json',JSON.stringify(S.vocab,null,2),'application/json'));
function dl(name,content,type){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type})); a.download=name; a.click();
}

// ═══════════════════════════════════════════
//  TTS  —  paragraph chunks, no gaps
// ═══════════════════════════════════════════
function jump(i){
  document.querySelectorAll('.sent.playing').forEach(el=>el.classList.remove('playing'));
  clearTtsWord();
  if(i !== S.idx) S.wordCs = 0;   // 换句时重置逐词位置
  S.idx = i;
  const el = document.querySelector(`.sent[data-i="${i}"]`);
  if(el){
    el.classList.add('playing');
    // Inject words so highlighting works
    injectWords(el);
    // Only recenter when the sentence is off-screen (behind the top bar or the
    // player) — otherwise the smooth scroll fires every sentence and fights the
    // user's own scrolling during playback.
    const r = el.getBoundingClientRect();
    if(r.top < 60 || r.bottom > window.innerHeight - 120){
      el.scrollIntoView({behavior:'smooth', block:'center'});
    }
  }
  updateProg(); saveProg();
  // While idle, warm the sentence the user just navigated to so pressing play
  // there is instant. Debounced so scrubbing only synthesizes the settled spot.
  // During playback _kokPrefetch already warms ahead.
  if(!S.playing) _kokWarmSoon(i);
}

// Build a chunk: join sentences into one utterance, track char offsets per sentence.
// startChar > 0 begins the FIRST sentence mid-way (word-level seek); later
// sentences are always whole.
function buildChunk(startIdx, startChar = 0){
  const MAX_CHARS = 300; // keep chunks short for responsiveness
  const offsets = []; // char position where each sentence starts
  const parts = [];
  let pos = 0, i = startIdx;
  while(i < S.sents.length){
    const s = i === startIdx ? S.sents[i].slice(startChar) : S.sents[i];
    if(parts.length > 0 && pos + s.length > MAX_CHARS) break;
    offsets.push(pos);
    parts.push(s);
    pos += s.length + 1;
    i++;
  }
  return { text: parts.join(' '), offsets, endIdx: i, startIdx, firstChar: startChar };
}

function getVoice(){
  if(S.selectedVoice) return S.selectedVoice;
  const lang = S.accentUS ? 'en-US' : 'en-GB';
  return synth.getVoices()
    .filter(v => v.lang === lang || v.lang.startsWith('en'))
    .sort((a,b) => qualityScore(b) - qualityScore(a))[0] || null;
}

function playChunk(chunk){
  const u = new SpeechSynthesisUtterance(chunk.text);
  u.lang  = S.accentUS ? 'en-US' : 'en-GB';
  u.rate  = S.speed;
  u.pitch = 1;
  const v = getVoice(); if(v) u.voice = v;

  let boundaryFired = false; // detect iOS no-onboundary fallback

  u.onboundary = e => {
    if(e.name !== 'word') return;
    boundaryFired = true;

    // 1. Which sentence in the chunk?
    let si = 0;
    for(let k = chunk.offsets.length - 1; k >= 0; k--){
      if(e.charIndex >= chunk.offsets[k]){ si = k; break; }
    }
    const globalIdx = chunk.startIdx + si;
    if(globalIdx !== S.idx) jump(globalIdx);

    // 2. Char position within this sentence (first sentence may be sliced)
    const sentCharIdx = e.charIndex - chunk.offsets[si] + (si === 0 ? chunk.firstChar : 0);

    // 3. Highlight that word in DOM
    const sentEl = document.querySelector(`.sent[data-i="${globalIdx}"]`);
    if(sentEl){
      injectWords(sentEl); // ensure spans exist
      highlightWordAt(sentEl, sentCharIdx);
    }
  };

  u.onend = () => {
    stopResumeTimer();
    clearTtsWord();
    if(chunk.endIdx < S.sents.length){
      S.idx = chunk.endIdx;
      const next = buildChunk(S.idx);
      jump(S.idx);
      startResumeTimer();
      synth.speak(makeUtterance(next));
    } else {
      S.playing = false; S.paused = false; setIcon(false);
    }
  };
  u.onerror = e => {
    if(e.error === 'interrupted') return;
    stopResumeTimer(); clearTtsWord();
    S.playing = false; S.paused = false; setIcon(false);
  };
  return u;
}

// ── TTS word highlight helpers
function clearTtsWord(){
  document.querySelectorAll('.word.tts-word').forEach(w => w.classList.remove('tts-word'));
  _cnClearHl();
}


// ── Confetti burst (hand-rolled canvas, zero dependency) ────────────
function confettiBurst(opts){
  opts = opts || {};
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  const colors = ['#2563EB','#7C3AED','#16A34A','#F59E0B','#EF4444','#60A5FA'];
  const N  = opts.count || 130;
  const cx = opts.x != null ? opts.x : W / 2;
  const cy = opts.y != null ? opts.y : H / 3;
  const parts = [];
  for(let i = 0; i < N; i++){
    const ang = Math.random() * Math.PI * 2, spd = 4 + Math.random() * 8;
    parts.push({ x:cx, y:cy, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd - 7,
      w:5+Math.random()*6, h:8+Math.random()*8, rot:Math.random()*6.28,
      vr:(Math.random()-.5)*.4, col:colors[(Math.random()*colors.length)|0], life:1 });
  }
  let t0 = performance.now();
  const draw = (t) => {
    const dt = Math.min((t - t0) / 16.67, 3); t0 = t;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for(const p of parts){
      p.vy += 0.22 * dt; p.vx *= 0.99;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      p.life -= 0.006 * dt;
      if(p.life > 0 && p.y < H + 40){
        alive = true;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.col;
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h); ctx.restore();
      }
    }
    if(alive) requestAnimationFrame(draw); else c.remove();
  };
  requestAnimationFrame(draw);
}

// ── Landing ambient particles (hand-rolled canvas) ──────────────────
function initLandingParticles(){
  const c = document.getElementById('landing-particles');
  if(!c || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = c.getContext('2d');
  const landing = document.getElementById('landing');
  let W = 0, H = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = landing.clientWidth; H = landing.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const N = Math.min(40, Math.max(16, Math.round((window.innerWidth * window.innerHeight) / 26000)));
  const dots = Array.from({length:N}, () => ({
    x:Math.random(), y:Math.random(), r:1 + Math.random()*2.4,
    vx:(Math.random()-.5)*0.00028, vy:(Math.random()-.5)*0.00028,
    a:0.12 + Math.random()*0.26,
  }));
  resize();
  window.addEventListener('resize', resize);
  let _pRaf = 0;
  const draw = () => {
    if(!landing || landing.offsetParent === null){
      // Landing hidden (user is reading): stop the 60fps loop and poll slowly
      // for it to be shown again, instead of spinning every frame (battery).
      _pRaf = 0;
      setTimeout(() => { if(!_pRaf) _pRaf = requestAnimationFrame(draw); }, 400);
      return;
    }
    ctx.clearRect(0, 0, W, H);
    const base = document.body.classList.contains('night') ? '150,170,255' : '90,120,220';
    for(const d of dots){
      d.x += d.vx; d.y += d.vy;
      if(d.x < 0) d.x = 1; else if(d.x > 1) d.x = 0;
      if(d.y < 0) d.y = 1; else if(d.y > 1) d.y = 0;
      ctx.beginPath();
      ctx.arc(d.x * W, d.y * H, d.r, 0, 6.2832);
      ctx.fillStyle = `rgba(${base},${d.a})`;
      ctx.fill();
    }
    _pRaf = requestAnimationFrame(draw);
  };
  _pRaf = requestAnimationFrame(draw);
}
initLandingParticles();

function highlightWordAt(sentEl, charIdx){
  clearTtsWord();
  const words = sentEl.querySelectorAll('.word[data-char-start]');
  let best = null;
  for(const w of words){
    const start = +w.dataset.charStart;
    const end   = start + w.textContent.length;
    if(charIdx >= start && charIdx < end){ best = w; break; }
    if(start <= charIdx) best = w; // closest word before charIdx
  }
  if(best){
    best.classList.add('tts-word');
    S.wordCs = +best.dataset.charStart;   // 记录当前词位置，供逐词前进/后退
    // 词对齐：朗读到的英文词 → 中文译文里对应字同步高亮
    if(S.bilin) _cnAlignHighlight(+sentEl.dataset.i, +best.dataset.charStart);
    // Subtle scroll — only if word is outside viewport
    const rect = best.getBoundingClientRect();
    if(rect.bottom > window.innerHeight - 180 || rect.top < 60){
      best.scrollIntoView({ behavior:'smooth', block:'center' });
    }
  }
}

function makeUtterance(chunk){ return playChunk(chunk); }

function playCurrent(){
  if(!S.sents.length) return;
  if(kokActive){ _unlockAudio(); kokStop(); kokPlay(); return; }
  synth.cancel(); stopResumeTimer();
  S.paused = false;
  const chunk = buildChunk(S.idx);
  jump(S.idx);
  S.playing = true; setIcon(true); startResumeTimer();
  synth.speak(playChunk(chunk));
}

// 从当前句的某个字符位置开始朗读（逐词前进/后退用）。startChar 落在某个词的起点。
function playFrom(startChar){
  if(!S.sents.length) return;
  if(kokActive){
    _unlockAudio(); kokStop();
    _kokStartChar = startChar;     // kokPlay 负责 jump + 高亮起始词
    kokPlay();
    return;
  }
  synth.cancel(); stopResumeTimer();
  S.paused = false;
  const chunk = buildChunk(S.idx, startChar);
  jump(S.idx);
  const el = document.querySelector(`.sent[data-i="${S.idx}"]`);  // 立即高亮起始词
  if(el){ injectWords(el); highlightWordAt(el, startChar); }
  S.playing = true; setIcon(true); startResumeTimer();
  synth.speak(playChunk(chunk));
}

// 逐词前进（dir>0）/ 后退（dir<0）：跳到相邻词并从那里接着播放，跨句自动衔接。
function stepWord(dir){
  if(!S.sents.length) return;
  const cs = S.wordCs || 0;
  const words = _enWords(S.sents[S.idx]);
  const target = dir > 0 ? words.find(w => w.cs > cs)
                         : [...words].reverse().find(w => w.cs < cs);
  if(target){ playFrom(target.cs); return; }
  // 已到本句首/尾 → 跨到相邻句
  if(dir > 0 && S.idx < S.sents.length - 1){
    S.idx++;
    const w = _enWords(S.sents[S.idx]);
    playFrom(w.length ? w[0].cs : 0);
  } else if(dir < 0 && S.idx > 0){
    S.idx--;
    const w = _enWords(S.sents[S.idx]);
    playFrom(w.length ? w[w.length - 1].cs : 0);
  }
}

function togglePlay(){
  if(kokActive){
    _unlockAudio(); // must be synchronous while user gesture is still active
    if(S.playing && !S.paused){
      // Two engines can be live: the gesture-blessed <audio> element (Kokoro /
      // Edge / Google) or the speechSynthesis fallback (common on iOS while
      // Kokoro is cold). Only the <audio> path can pause/resume mid-sentence;
      // pausing it is a clean soft-pause. speechSynthesis can't reliably
      // pause/resume mid-utterance, and calling _kokAudioEl.pause() would leave
      // the system voice talking (uncontrollable) and overlap on resume — so
      // hard-stop it and mark paused, which replays the current sentence.
      const audioLive = _kokAudioEl && !_kokAudioEl.paused &&
                        _kokAudioEl.src && !_kokAudioEl.ended;
      if(audioLive){
        S.paused = true; S.playing = false; setIcon(false);
        _kokSoftPaused = true;
        _kokAudioEl.pause();
      } else {
        kokStop();   // cancels the in-flight synth utterance / fetch
        S.paused = true; S.playing = false; setIcon(false);
      }
    } else if(S.paused){
      S.paused = false;
      if(_kokSoftPaused && _kokAudioEl && _kokAudioEl.src && !_kokAudioEl.ended){
        _kokSoftPaused = false;
        _kokAudioEl.play().then(()=>{ setIcon(true); S.playing = true; }).catch(()=>{ _kokSoftPaused = false; kokPlay(); });
        return;
      }
      _kokSoftPaused = false;
      kokPlay();
    } else if(S.sents.length){ kokPlay(); }
    return;
  }
  if(S.playing && !S.paused){
    synth.pause(); S.paused = true; S.playing = false;
    stopResumeTimer(); setIcon(false);
  } else if(S.paused){
    synth.resume(); S.paused = false; S.playing = true;
    startResumeTimer(); setIcon(true);
  } else {
    playCurrent();
  }
}

function setIcon(playing){
  const _pl = document.getElementById('player');
  if(_pl) _pl.classList.toggle('playing', playing);   // drives progress-bar sheen
  // Lottie play↔pause morph when mounted; SVG swap as offline fallback.
  if(_licons.play){ Licon.setState(_licons.play, playing); return; }
  const ico = document.getElementById('play-ico');
  if(ico) ico.outerHTML = playing
    ? `<svg id="play-ico" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/></svg>`
    : `<svg id="play-ico" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><polygon points="6 3 20 12 6 21"/></svg>`;
}

// ── Lottie micro-interaction icons (see licon.js) ──────────────
const _licons = {};
async function _initLicons(){
  if(typeof Licon === 'undefined') return;
  const $ = id => document.getElementById(id);

  // Player: play/pause morph + prev/next nudge
  _licons.play = await Licon.mount($('play-btn'), 'playPause');
  if(_licons.play) setIcon(S.playing);   // sync to current state
  _licons.prev = await Licon.mount($('prev-btn'), 'skipBack');
  _licons.next = await Licon.mount($('next-btn'), 'skipForward');
  $('prev-btn').addEventListener('click', () => Licon.nudge(_licons.prev));
  $('next-btn').addEventListener('click', () => Licon.nudge(_licons.next));

  // Top bar: search↔X, settings gear, chapter menu, vocab bookmark
  _licons.search = await Licon.mount($('srch-tbtn'), 'searchToX');
  $('srch-tbtn').addEventListener('click', () => Licon.setState(_licons.search, S.srchOpen));
  $('s-close').addEventListener('click', () => Licon.setState(_licons.search, false));

  _licons.settings = await Licon.mount($('set-tbtn'), 'settings2');
  $('set-tbtn').addEventListener('mouseenter', () => Licon.nudge(_licons.settings));
  $('set-tbtn').addEventListener('click', () => Licon.nudge(_licons.settings));

  _licons.chap = await Licon.mount($('chap-tbtn'), 'menu');
  $('chap-tbtn').addEventListener('click', () => Licon.nudge(_licons.chap));

  _licons.voc = await Licon.mount($('voc-tbtn'), 'bookmark');
  $('voc-tbtn').addEventListener('click', () => Licon.nudge(_licons.voc));

  // Word popup: heart pop when adding to vocabulary
  _licons.learn = await Licon.mount($('wp-learn-ico'), 'heart');
  $('wp-learn').addEventListener('click', () => Licon.nudge(_licons.learn));
}
_initLicons();

document.getElementById('play-btn').addEventListener('click', togglePlay);

document.getElementById('prev-btn').addEventListener('click',()=>{
  if(S.idx>0){ S.idx--; jump(S.idx); if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); } }
});
document.getElementById('next-btn').addEventListener('click',()=>{
  if(S.idx<S.sents.length-1){ S.idx++; jump(S.idx); if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); } }
});
document.getElementById('prevword-btn').addEventListener('click',()=>{ _unlockAudio(); stepWord(-1); });
document.getElementById('nextword-btn').addEventListener('click',()=>{ _unlockAudio(); stepWord(1); });

// ── SPEED: single button + popup
const speedWrap = document.getElementById('speed-wrap');
const speedBtn  = document.getElementById('speed-btn');
const speedPop  = document.getElementById('speed-popup');

speedBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = speedPop.classList.toggle('open');
  speedBtn.classList.toggle('active', open);
});
document.addEventListener('click', () => {
  speedPop.classList.remove('open');
  speedBtn.classList.remove('active');
});
speedPop.addEventListener('click', e => e.stopPropagation());

document.querySelectorAll('.spill').forEach(btn => {
  btn.addEventListener('click', () => {
    applySpeed(+btn.dataset.s);
    speedPop.classList.remove('open');
    speedBtn.classList.remove('active');
    // Kokoro / online audio: playbackRate is set live in applySpeed — no restart needed.
    // SpeechSynthesis can't change rate mid-utterance, so restart is still required there.
    if(!kokActive && (S.playing||S.paused)){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); }
  });
});

function applySpeed(s){
  S.speed = s;
  speedBtn.textContent = s + 'x';
  document.querySelectorAll('.spill').forEach(b => b.classList.toggle('on', +b.dataset.s === s));
  // Instantly adjust speed of any currently-playing <audio> (Kokoro / Edge / Google)
  if(_kokAudioEl){ try{ _kokAudioEl.playbackRate = s; }catch(e){} }
  saveProg();
}

// ── ACCENT

// ── PROGRESS BAR
document.getElementById('prog-wrap').addEventListener('click', e=>{
  const pct=e.offsetX/e.currentTarget.offsetWidth;
  S.idx=Math.max(0,Math.min(Math.floor(pct*S.sents.length),S.sents.length-1));
  jump(S.idx);
  if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); }
});
function updateProg(){
  const pct=S.sents.length?(S.idx/S.sents.length)*100:0;
  document.getElementById('prog-fill').style.width=pct.toFixed(1)+'%';
  document.getElementById('prog-pct').textContent=Math.round(pct)+'%';
  document.getElementById('pct-badge').textContent=Math.round(pct)+'%';
}
// ═══════════════════════════════════════════
//  SEARCH
// ═══════════════════════════════════════════
document.getElementById('srch-tbtn').addEventListener('click',()=>{
  S.srchOpen=!S.srchOpen;
  document.getElementById('search-bar').classList.toggle('vis',S.srchOpen);
  if(S.srchOpen) document.getElementById('search-in').focus(); else clearSrch();
});
document.getElementById('s-close').addEventListener('click',()=>{
  document.getElementById('search-bar').classList.remove('vis'); S.srchOpen=false; clearSrch();
});
let srchTimer;
document.getElementById('search-in').addEventListener('input', e=>{
  clearTimeout(srchTimer); srchTimer=setTimeout(()=>doSearch(e.target.value.trim()),180);
});
document.getElementById('s-prev').addEventListener('click',()=>navSrch(-1));
document.getElementById('s-next').addEventListener('click',()=>navSrch(1));
function doSearch(q){
  clearSrch(false); if(!q||q.length<2){ updSrchCt(); return; }
  const re=new RegExp(esc(q),'gi'); S.srchHits=[];
  document.querySelectorAll('.word').forEach(w=>{ if(re.test(w.textContent)){ w.classList.add('sh'); S.srchHits.push(w); } re.lastIndex=0; });
  S.srchIdx=0; if(S.srchHits.length) goMatch(0); updSrchCt();
}
function navSrch(d){ if(!S.srchHits.length) return; S.srchIdx=(S.srchIdx+d+S.srchHits.length)%S.srchHits.length; goMatch(S.srchIdx); updSrchCt(); }
function goMatch(i){ S.srchHits.forEach(m=>m.classList.remove('cur')); const el=S.srchHits[i]; if(el){ el.classList.add('cur'); el.scrollIntoView({behavior:'smooth',block:'center'}); } }
function clearSrch(ri=true){ document.querySelectorAll('.sh').forEach(el=>el.classList.remove('sh','cur')); S.srchHits=[]; if(ri) document.getElementById('search-in').value=''; updSrchCt(); }
function updSrchCt(){ document.getElementById('search-ct').textContent=S.srchHits.length?`${S.srchIdx+1}/${S.srchHits.length}`:'0/0'; }
function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

// ═══════════════════════════════════════════
//  SETTINGS / MODES
// ═══════════════════════════════════════════
// ── SIDEBAR
const sidebar = document.getElementById('sidebar');
document.getElementById('set-tbtn').addEventListener('click', () => {
  sidebar.classList.toggle('open');
  document.getElementById('overlay').classList.toggle('vis', sidebar.classList.contains('open'));
});
document.getElementById('sb-close').addEventListener('click', closeSidebar);
function closeSidebar(){
  sidebar.classList.remove('open');
  document.getElementById('overlay').classList.remove('vis');
}

// Font size
document.getElementById('sb-font-range').addEventListener('input', e => {
  S.fontSize = +e.target.value; applyFont(); saveProg();
});
function applyFont(){
  document.getElementById('sb-font-range').value = S.fontSize;
  document.querySelectorAll('.sent').forEach(el => el.style.fontSize = S.fontSize + 'px');
}

// Line height
document.querySelectorAll('.sb-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    S.lineHeight = +btn.dataset.lh;
    document.querySelectorAll('.sb-pill').forEach(b => b.classList.toggle('on', b === btn));
    applyLineHeight(); saveProg();
  });
});
function applyLineHeight(){
  const lh = S.lineHeight || 2.05;
  document.querySelectorAll('.sent').forEach(el => el.style.lineHeight = lh);
  document.querySelectorAll('.sb-pill').forEach(b => b.classList.toggle('on', +b.dataset.lh === lh));
}

// Text align
document.querySelectorAll('.sb-align-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    S.textAlign = btn.dataset.align;
    document.querySelectorAll('.sb-align-btn').forEach(b => b.classList.toggle('on', b === btn));
    applyTextAlign(); saveProg();
  });
});
function applyTextAlign(){
  const ta = S.textAlign || 'left';
  document.getElementById('content').style.textAlign = ta;
  document.querySelectorAll('.sb-align-btn').forEach(b => b.classList.toggle('on', b.dataset.align === ta));
}

// Night mode
const nightToggle = document.getElementById('night-toggle');
document.getElementById('night-btn').addEventListener('click', () => { S.night=!S.night; applyNight(); saveProg(); });
nightToggle.addEventListener('click', () => { S.night=!S.night; applyNight(); saveProg(); });
function applyNight(){
  document.body.classList.toggle('night', S.night);
  nightToggle.classList.toggle('on', S.night);
}

// Modes
document.querySelectorAll('.sb-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    S.mode = btn.dataset.mode; applyMode(); updMbtns(); saveProg();
  });
});
function _syncNalignRow(){
  const row = document.getElementById('nalign-row');
  if(row) row.style.display = S.bilin ? 'flex' : 'none';
  const btn = document.getElementById('nalign-toggle');
  if(btn) btn.classList.toggle('on', NALIGN.isEnabled());
}
document.getElementById('bilin-toggle').addEventListener('click', () => {
  S.bilin = !S.bilin;
  applyBilin();
  _syncNalignRow();
  saveProg();
  if(S.bilin) toast('中英对照已开启');
});
document.getElementById('nalign-toggle').addEventListener('click', () => {
  const on = !NALIGN.isEnabled();
  NALIGN.setEnabled(on);
  document.getElementById('nalign-toggle').classList.toggle('on', on);
  toast(on ? '神经词对齐已开启，正在准备模型…' : '已切回词典对齐');
});
_syncNalignRow();

function applyMode(){
  document.querySelectorAll('.word').forEach(w => w.classList.remove('w-blur'));
  document.querySelectorAll('.tl-line').forEach(el => { el.style.display = S.mode==='immersive' ? 'none' : ''; });
  if(S.mode === 'vocab'){
    document.querySelectorAll('.word').forEach(w => { if(Math.random()<.35) w.classList.add('w-blur'); });
  }
}
function updMbtns(){
  document.querySelectorAll('.sb-mode-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
}

// ═══════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════
let tTimer;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  clearTimeout(tTimer); tTimer=setTimeout(()=>el.classList.remove('show'),2300);
}

// ── KEYBOARD (reader)
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT') return;
  // 闪卡打开时，所有按键交由闪卡自己的 keydown 处理
  if(document.getElementById('flashcard').classList.contains('open')) return;
  if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
  if(e.code==='ArrowRight') document.getElementById(e.shiftKey?'nextword-btn':'next-btn').click();
  if(e.code==='ArrowLeft')  document.getElementById(e.shiftKey?'prevword-btn':'prev-btn').click();
  if(e.key==='Escape'){
    wpop.classList.remove('vis');
    document.getElementById('library').classList.remove('open');

    closeSidebar();
    closeVoc();
  }
});
// ══════════════════════════════════════════
//  我的书架
// ══════════════════════════════════════════
let userBooks = [];

const GB_PALS = [
  ["#7B6CF6","#B794F4"],["#48BB78","#F6E05E"],["#F6AD55","#FC8181"],
  ["#63B3ED","#2B6CB0"],["#F687B3","#B83280"],["#68D391","#276749"],
  ["#ECC94B","#C05621"],["#76E4F7","#0987A0"],["#FC8181","#9AE6B4"],
  ["#C53030","#1A202C"],["#2C5282","#81E6D9"],["#B7791F","#1A202C"]
];

function gbFormatAuthor(name){
  const p = name.split(', ');
  return p.length === 2 ? p[1] + ' ' + p[0] : name;
}

function injectGbId(b){
  if(b._gbId) return b;
  const m = b.url && b.url.match(/\/files\/(\d+)\//);
  return {...b, _gbId: m ? parseInt(m[1]) : null};
}
function loadLocalUserBooks(){
  try{ return JSON.parse(localStorage.getItem('my_books') || '[]'); }catch(e){ return []; }
}
function saveLocalUserBooks(books){
  try{ localStorage.setItem('my_books', JSON.stringify(books)); }catch(e){}
}

async function loadUserBooks(){
  if(currentUser){
    try{
      const rows = await SB.selectUserBooks(currentUser.id);
      userBooks = rows.map(r => {
        const m = r.url && r.url.match(/\/files\/(\d+)\//);
        return {
          _id: r.id, t: r.title, a: r.author, y: r.year,
          url: r.url, mark: r.mark || 'Chapter', isbn: r.isbn,
          pal: r.pal || GB_PALS[0], cat: r.cat || ['classic'],
          _mine: true, _gbId: m ? parseInt(m[1]) : null
        };
      });
      // 迁移本地书到云端
      const local = loadLocalUserBooks();
      for(const lb of local){
        if(!userBooks.some(b => b.url === lb.url)){
          await addUserBook(lb, true);
        }
      }
      saveLocalUserBooks([]);
    }catch(e){ userBooks = loadLocalUserBooks().map(injectGbId); }
  } else {
    userBooks = loadLocalUserBooks().map(injectGbId);
  }
  renderUserBooks();
}

async function addUserBook(gbBook, skipRender){
  const pal = GB_PALS[Math.floor(Math.random() * GB_PALS.length)];
  // Extract Gutenberg ID from URL for cover image
  const gbIdMatch = gbBook.url && gbBook.url.match(/\/files\/(\d+)\//);
  const gbId = gbBook._gbId || (gbIdMatch ? parseInt(gbIdMatch[1]) : null);
  const book = {
    t: gbBook.t, a: gbBook.a, y: gbBook.y || 0,
    url: gbBook.url, mark: gbBook.mark || 'Chapter',
    isbn: gbBook.isbn || null, pal: gbBook.pal || pal,
    cat: gbBook.cat || ['classic'], _mine: true,
    _gbId: gbId
  };
  if(currentUser){
    try{
      const rows = await SB.insertUserBook({
        user_id: currentUser.id,
        title: book.t, author: book.a, year: book.y,
        url: book.url, mark: book.mark,
        isbn: book.isbn, pal: book.pal, cat: book.cat
      });
      book._id = rows[0]?.id;
    }catch(e){ console.error('保存书架失败', e); return false; }
  } else {
    book._id = Date.now() + Math.random().toString(36).slice(2);
    const local = loadLocalUserBooks();
    local.push({...book});
    saveLocalUserBooks(local);
  }
  userBooks.push(book);
  if(!skipRender) renderUserBooks();
  return true;
}

async function removeUserBook(book){
  userBooks = userBooks.filter(b => b !== book);
  if(currentUser && book._id){
    try{ await SB.deleteUserBook(book._id); }catch(e){}
  } else {
    const local = loadLocalUserBooks().filter(b => b._id !== book._id && b.url !== book.url);
    saveLocalUserBooks(local);
  }
  renderUserBooks();
}

function renderUserBooks(){
  const section = document.getElementById('lib-level-mine');
  const row = document.getElementById('lib-row-mine');
  const badge = document.getElementById('mine-count');
  row.innerHTML = '';
  if(userBooks.length === 0){ section.style.display = 'none'; return; }
  section.style.display = '';
  badge.textContent = userBooks.length + ' 本';
  userBooks.forEach(book => {
    const card = buildCard(book);
    // 加删除按钮
    const rm = document.createElement('button');
    rm.className = 'bk-remove';
    rm.title = '从书架移除';
    rm.textContent = '✕';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      if(confirm(`从书架移除《${book.t}》？`)) removeUserBook(book);
    });
    card.querySelector('.bk-cover').appendChild(rm);
    row.appendChild(card);
  });
}

// ── Gutenberg 搜索
// ── 本地书目搜索（离线、即时、评分排序）
function norm(s){
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

function localSearch(q){
  const qn = norm(q.trim());
  if(!qn) return [];
  const words = qn.split(/\s+/).filter(w => w.length > 0);

  // 合并内置书库 + CATALOG（去重）
  const builtinUrls = new Set(BOOKS.flat().map(b => b.url));
  const catalogPool = CATALOG.map(([id,t,a,y,cat,mark]) => ({
    t, a, y, cat, mark: mark || 'Chapter', isbn: null,
    url: `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    pal: GB_PALS[id % GB_PALS.length], _gbId: id
  })).filter(b => !builtinUrls.has(b.url));

  const pool = [
    ...BOOKS.flat().map(b => ({...b, _builtin:true})),
    ...catalogPool
  ];

  function scoreBook(b){
    const tl = norm(b.t), al = norm(b.a);
    if(tl === qn) return 1000;
    let s = 0;
    if(tl.startsWith(qn)) s += 80;
    else if(tl.includes(qn)) s += 50;
    const tHits = words.filter(w => tl.includes(w)).length;
    const aHits = words.filter(w => al.includes(w)).length;
    if(tHits === words.length && words.length > 1) s += 40;
    s += tHits * 15;
    if(aHits === words.length) s += 20;
    s += aHits * 8;
    return s;
  }

  return pool
    .map(b => ({b, s: scoreBook(b)}))
    .filter(({s}) => s > 0)
    .sort((a,b) => b.s - a.s)
    .slice(0, 30)
    .map(({b}) => b);
}

function renderSearchResults(results){
  const res = document.getElementById('gb-results');
  if(!results.length){
    res.innerHTML = '<div class="gb-empty">没有找到结果，换个关键词试试</div>';
    return;
  }
  res.innerHTML = `<div class="gb-count">找到 ${results.length} 本</div>`;
  results.forEach(book => res.appendChild(buildSearchCard(book)));
}

// Search-result card: cover grid (readest-style). Tapping cover/title opens the
// book detail sheet (openBookPreview); the button adds the book to the shelf.
function buildSearchCard(book){
  const div = document.createElement('div');
  div.className = 'gb-card';
  div._book = book;
  const [c1,c2]   = book.pal || ['#667eea','#764ba2'];
  const hasIsbn   = book.isbn && book.isbn !== 'null' && book.isbn !== '';
  const imgSrc    = hasIsbn ? coverUrl(book.isbn)
                  : book._gbId ? gbCoverUrl(book._gbId) : null;
  const isBuiltin = !!book._builtin;
  const isAdded   = userBooks.some(b => b.url === book.url);
  const disabled  = isBuiltin || isAdded;
  const btnText   = isBuiltin ? '已内置' : isAdded ? '已添加' : '+ 添加';
  div.innerHTML = `
    <div class="gb-cover">
      ${imgSrc ? `<img src="${_esc(imgSrc)}" alt="${_esc(book.t)}" loading="lazy">` : ''}
      <div class="bk-cover-fallback" style="${imgSrc?'display:none;':'display:flex;'}background:linear-gradient(145deg,${c1},${c2})">
        <div class="bk-fb-title">${_esc(book.t)}</div>
        <div class="bk-fb-author">${_esc(book.a.split(' ').pop())}</div>
        <div class="bk-fb-deco"></div>
      </div>
    </div>
    <div class="gb-ttl">${_esc(book.t)}</div>
    <div class="gb-au">${_esc(book.a)}${book.y ? ' · ' + _esc(String(book.y)) : ''}</div>
    <button class="gb-add-btn"${disabled?' disabled':''}>${_esc(btnText)}</button>`;
  if(imgSrc){
    const img = div.querySelector('img');
    const fb  = div.querySelector('.bk-cover-fallback');
    img.onerror = () => { img.style.display='none'; fb.style.display='flex'; };
  }
  const openDetail = e => { e.stopPropagation(); openBookPreview(book, div, {search:true}); };
  div.querySelector('.gb-cover').addEventListener('click', openDetail);
  div.querySelector('.gb-ttl').addEventListener('click', openDetail);
  if(!disabled){
    div.querySelector('.gb-add-btn').addEventListener('click', async function(e){
      e.stopPropagation();
      this.disabled = true; this.textContent = '添加中…';
      const ok = await addUserBook(book);
      this.textContent = ok ? '已添加' : '失败';
    });
  }
  return div;
}

// ── 每日英语（Simple English Wikipedia，无需代理）
let voaLoaded = false;

const WIKI_PALS = [
  ['#1a1a2e','#16213e'],['#0f3460','#533483'],
  ['#2d6a4f','#1b4332'],['#6b21a8','#3b0764'],
  ['#991b1b','#7f1d1d'],['#1a535c','#0d3b47'],
  ['#92400e','#78350f'],['#1e3a5f','#0c2340'],
];

async function loadVoaFeed(){
  const voaEl = document.getElementById('lib-level-voa');
  try{
    const ctrl = new AbortController();
    const tid  = setTimeout(()=>ctrl.abort(), 12000);
    const resp = await fetch(
      'https://simple.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&grnlimit=8&prop=extracts|pageimages&exintro=1&exsentences=2&explaintext=1&pithumbsize=400&format=json&origin=*',
      {signal:ctrl.signal}
    );
    clearTimeout(tid);
    if(!resp.ok) throw new Error('fetch failed');
    const data  = await resp.json();
    const pages = Object.values(data.query?.pages || {});
    if(!pages.length) throw new Error('empty');
    const articles = pages.map(p =>({
      t:    p.title,
      url:  `https://simple.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g,'_'))}`,
      desc: (p.extract||'').slice(0,120).trim(),
      img:  p.thumbnail?.source || '',
      _wiki: true,
    }));
    renderVoaArticles(articles);
    voaEl.style.display = '';
  }catch(e){
    console.warn('Wiki articles fail',e);
    voaEl.style.display = 'none';
  }
}

function renderVoaArticles(articles){
  const el = document.getElementById('voa-articles');
  el.innerHTML = '';
  articles.forEach((article, i) => {
    const div = document.createElement('div');
    div.className = 'voa-card';
    const [c1, c2] = WIKI_PALS[i % WIKI_PALS.length];
    const bgStyle = article.img
      ? `class="voa-card-bg has-img" style="background-image:url('${_esc(article.img)}')" `
      : `class="voa-card-bg" style="background:linear-gradient(135deg,${c1},${c2})"`;
    div.innerHTML = `
      <div ${bgStyle}></div>
      ${article.img ? `<img class="voa-card-img" src="${_esc(article.img)}" alt="" loading="lazy">` : ''}
      <div class="voa-card-overlay"></div>
      <div class="voa-card-body">
        <span class="voa-card-src">Simple Wikipedia</span>
        <div class="voa-card-title">${_esc(article.t)}</div>
        ${article.desc ? `<div class="voa-card-desc">${_esc(article.desc)}</div>` : ''}
      </div>
      <div class="voa-card-loader" style="display:none"><span>加载中…</span></div>`;
    div.addEventListener('click', () => loadVoaArticle(article, div));
    el.appendChild(div);
  });
}

async function loadVoaArticle(article, cardEl){
  const loader = cardEl.querySelector('.voa-card-loader');
  if(loader) loader.style.display = '';
  try{
    const cached = await idbGet(article.url);
    if(cached){
      openBook({t:article.t,a:'Simple English Wikipedia',url:article.url,pal:['#3498db','#2980b9']},cached);
      return;
    }
  }catch(e){}
  if(article._wiki){
    try{
      const ctrl = new AbortController();
      const tid  = setTimeout(()=>ctrl.abort(), 15000);
      const resp = await fetch(
        `https://simple.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(article.t)}&prop=extracts&format=json&origin=*&explaintext=1`,
        {signal:ctrl.signal}
      );
      clearTimeout(tid);
      if(!resp.ok) throw new Error('fetch failed');
      const data = await resp.json();
      const page = Object.values(data.query?.pages||{})[0];
      const txt  = (page?.extract||'').replace(/\n{4,}/g,'\n\n\n').trim();
      if(!txt) throw new Error('empty');
      await idbSave(article.url, txt);
      openBook({t:article.t,a:'Simple English Wikipedia',url:article.url,pal:['#3498db','#2980b9']},txt);
      return;
    }catch(e){ console.warn('wiki article fail',e); }
  }
  if(loader) loader.style.display = 'none';
  toast('加载失败，请检查网络连接');
}

// ── Standard Ebooks search
function localSearchSE(q){
  if(!q) return SE_BOOKS;
  q = q.toLowerCase();
  return SE_BOOKS.filter(b =>
    b.t.toLowerCase().includes(q) ||
    b.a.toLowerCase().includes(q) ||
    b.cat.some(c => c.includes(q))
  );
}

// ── Gutendex (Gutenberg JSON API) — 70,000+ books, CORS-enabled
const _GDX_PALS = [
  ['#fdf2e9','#d35400'],['#e8f8f5','#1a6b4a'],['#eaf2ff','#1a5276'],
  ['#fef9e7','#b7950b'],['#fdedec','#7b241c'],['#f4ecf7','#6c3483'],
  ['#1c2833','#d4ac0d'],['#d5f5e3','#1e8449'],['#d7dbdd','#2c3e50'],
  ['#1a2a3a','#5dade2'],['#1c1c1c','#f1c40f'],['#2c3e50','#85929e'],
];

function _gutendexToBook(gb){
  const id = gb.id;
  const authorRaw = (gb.authors[0] || {}).name || '';
  const a = authorRaw.includes(',')
    ? authorRaw.split(', ').reverse().join(' ')
    : (authorRaw || 'Unknown');
  const t = gb.title || 'Unknown';
  const y = (gb.authors[0] || {}).birth_year || null;
  const fmts = gb.formats || {};
  // prefer UTF-8 text, fall back to plain text or the standard pattern
  const txtUrl = fmts['text/plain; charset=utf-8']
    || fmts['text/plain; charset=us-ascii']
    || fmts['text/plain']
    || `https://www.gutenberg.org/files/${id}/${id}-0.txt`;
  const subj = [...(gb.subjects||[]), ...(gb.bookshelves||[])].join(' ').toLowerCase();
  const cat = [];
  if(/detective|mystery|crime|thriller/.test(subj)) cat.push('mystery');
  if(/adventure|sea voyage|island|pirate/.test(subj)) cat.push('adventure');
  if(/science fiction|sci-fi|utopia/.test(subj)) cat.push('scifi');
  if(/horror|ghost|supernatural|gothic/.test(subj)) cat.push('horror');
  if(/short stor|tales|fable|sketch/.test(subj)) cat.push('short');
  if(!cat.length) cat.push('classic');
  const pal = _GDX_PALS[id % _GDX_PALS.length];
  return { t, a, y, cat, mark: '', url: txtUrl, isbn: null, _gbId: id, pal };
}

// Map our UI categories → Gutendex `topic` (matches subjects + bookshelves).
// 'classic' has no single subject, so use 'fiction' — Gutendex sorts by
// download count, so the top results are exactly the canonical classics.
const GDX_TOPICS = {
  mystery:   'detective',
  adventure: 'adventure',
  scifi:     'science fiction',
  horror:    'horror',
  short:     'short stories',
  classic:   'fiction',
};

// Fetch from Gutendex with optional free-text search and/or topic filter.
async function _gutendexFetch({ search, topic }){
  const params = new URLSearchParams({ languages: 'en' });
  if(search) params.set('search', search);
  if(topic)  params.set('topic', topic);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10000);
  try{
    const resp = await fetch(`https://gutendex.com/books/?${params}`, {signal: ctrl.signal});
    clearTimeout(tid);
    if(!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map(_gutendexToBook);
  }catch(e){
    clearTimeout(tid);
    return [];
  }
}

// ── 浏览面板事件
const gbPanel  = document.getElementById('gb-panel');
const gbAddBtn = document.getElementById('lib-add-btn');

let gbBrowseFilter = 'all';  // current category filter in browse panel
let _gbSearchSeq = 0;  // stale-result guard for async Gutendex calls

// Build the CATALOG pool with all browseable fields
function _catalogPool(){
  return CATALOG.map(([id,t,a,y,cat,mark]) => ({
    t, a, y, cat, mark: mark || 'Chapter',
    url: `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    isbn: null, _gbId: id,
  }));
}

async function browseCatalog(filter){
  const mySeq = ++_gbSearchSeq;
  gbBrowseFilter = filter;
  const q = (libSearchEl.value || '').trim();
  const ql = q.toLowerCase();

  // Phase 1: local results shown immediately (offline-capable)
  let local = [..._catalogPool(), ...SE_BOOKS];
  if(filter !== 'all') local = local.filter(b => b.cat && b.cat.includes(filter));
  if(ql) local = local.filter(b =>
    b.t.toLowerCase().includes(ql) || b.a.toLowerCase().includes(ql));
  renderSearchResults(local);

  // Phase 2: hit Gutendex whenever there's a query OR a category selected,
  // so categories browse the full online catalog by topic — not just locals.
  const topic = filter !== 'all' ? GDX_TOPICS[filter] : '';
  if(!q && !topic) return;  // 全部 + 无关键词 = 纯本地浏览

  const res = document.getElementById('gb-results');
  if(res){
    const note = document.createElement('div');
    note.className = 'gb-api-status';
    note.textContent = q
      ? '正在搜索 Gutenberg 7 万本全库…'
      : `正在加载「${CAT_LABELS[filter] || filter}」分类的在线书目…`;
    res.appendChild(note);
  }

  const apiBooks = await _gutendexFetch({ search: q, topic });
  if(_gbSearchSeq !== mySeq) return;  // another search/filter started, discard

  // Deduplicate against local results
  const localGbIds = new Set(local.filter(b => b._gbId).map(b => b._gbId));
  const fresh = apiBooks.filter(b => !localGbIds.has(b._gbId));

  document.querySelector('.gb-api-status')?.remove();
  if(!fresh.length) return;

  renderSearchResults([...local, ...fresh]);
  const countEl = document.querySelector('#gb-results .gb-count');
  if(countEl) countEl.textContent =
    `找到 ${local.length + fresh.length} 本（含 Gutenberg 在线结果）`;
}

// Category chip clicks inside browse panel
document.querySelectorAll('.gbcat').forEach(btn => {
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.gbcat').forEach(b => b.classList.toggle('on', b===btn));
    browseCatalog(btn.dataset.gc);
  });
});

// Legacy lib-add-btn (kept for compatibility, redirects to browse)
if(gbAddBtn){
  gbAddBtn.addEventListener('click', openBrowsePanel);
}

// ── UI helpers
function setAuthUI(user){
  currentUser = user;
  const loginBtn = document.getElementById('login-btn');
  const userBtn  = document.getElementById('user-btn');
  if(user){
    loginBtn.style.display = 'none';
    userBtn.style.display  = '';
    const initials = (user.email||'?')[0].toUpperCase();
    userBtn.textContent = initials;
    document.getElementById('um-avatar').textContent = initials;
    document.getElementById('um-name').textContent   = (user.email||'').split('@')[0];
    document.getElementById('um-email').textContent  = user.email;
  } else {
    loginBtn.style.display = '';
    userBtn.style.display  = 'none';
  }
}

// ── Sync: pull from Supabase then push local orphans
async function syncVocab(){
  if(!currentUser) return;
  try{
    const data = await SB.selectVocab(currentUser.id);
    const cloudWords = new Set(data.map(r => r.word));
    let added = 0;
    for(const row of data){
      if(!S.vocab.some(v => v.word === row.word)){
        S.vocab.push({ word:row.word, meaning:row.meaning||'', sent:row.sent||'', time:row.time||Date.now() });
        S.savedWords.add(row.word);
        added++;
      }
    }
    const localOnly = S.vocab.filter(v => !cloudWords.has(v.word));
    if(localOnly.length){
      await SB.upsertVocab(localOnly.map(v => ({
        user_id: currentUser.id, word:v.word, meaning:v.meaning, sent:v.sent, time:v.time
      })));
    }
    saveProg(); renderVoc();
    toast(`同步完成，共 ${S.vocab.length} 词`);
  }catch(e){
    console.error('sync error', e);
    toast('同步失败：' + e.message);
  }
}

// ── Cloud add / delete (called alongside local ops)
async function cloudAddVocab(item){
  if(!currentUser) return;
  await SB.upsertVocab([{ user_id: currentUser.id, word:item.word, meaning:item.meaning, sent:item.sent, time:item.time }])
    .catch(e => console.warn('cloud add failed', e));
}
async function cloudDeleteVocab(word){
  if(!currentUser) return;
  await SB.deleteVocab(currentUser.id, word)
    .catch(e => console.warn('cloud delete failed', e));
}

// ── Auth modal logic
let authMode = 'login';

document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', ()=>{
    authMode = btn.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('on', b === btn));
    document.getElementById('auth-submit').textContent = authMode === 'login' ? '登录' : '注册';
    document.getElementById('auth-err').textContent = '';
    document.getElementById('auth-pass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  });
});

document.getElementById('login-btn').addEventListener('click', ()=>{
  document.getElementById('auth-modal').classList.add('open');
  document.getElementById('auth-email').focus();
});
document.getElementById('auth-close').addEventListener('click', ()=>{
  document.getElementById('auth-modal').classList.remove('open');
});
document.getElementById('auth-modal').addEventListener('click', e=>{
  if(e.target === document.getElementById('auth-modal'))
    document.getElementById('auth-modal').classList.remove('open');
});

document.getElementById('auth-submit').addEventListener('click', async ()=>{
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  const errEl = document.getElementById('auth-err');
  const btn   = document.getElementById('auth-submit');

  if(!email || !pass){ errEl.textContent = '请填写邮箱和密码'; return; }
  if(pass.length < 8){ errEl.textContent = '密码至少 8 位'; return; }

  btn.disabled = true;
  btn.textContent = '处理中…';
  errEl.textContent = '';

  try{
    let user;
    if(authMode === 'login'){
      user = await SB.signIn(email, pass);
    } else {
      user = await SB.signUp(email, pass);
    }
    setAuthUI(user);
    document.getElementById('auth-modal').classList.remove('open');
    if(authMode === 'register'){
      toast('注册成功！请查收验证邮件（如有）');
    } else {
      toast('登录成功');
      await syncVocab();
      await loadUserBooks();
      if(typeof window._syncFcSRS === 'function') window._syncFcSRS();
      if(typeof window._syncVpProgress === 'function') window._syncVpProgress();
    }
  }catch(e){
    const msg = e.message || '操作失败';
    errEl.textContent =
      msg.includes('Invalid login') ? '邮箱或密码错误' :
      msg.includes('already registered') ? '该邮箱已注册，请直接登录' :
      msg.includes('Email not confirmed') ? '请先验证邮箱' : msg;
  }finally{
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? '登录' : '注册';
  }
});

// Enter key submits
['auth-email','auth-pass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if(e.key === 'Enter') document.getElementById('auth-submit').click();
  });
});

// ── User menu (bottom sheet)
const userBtn      = document.getElementById('user-btn');
const userMenu     = document.getElementById('user-menu');
const userMenuOvl  = document.getElementById('user-menu-overlay');

function openUserMenu(){
  userMenu.classList.add('open');
  userMenuOvl.classList.add('open');
}
function closeUserMenu(){
  userMenu.classList.remove('open');
  userMenuOvl.classList.remove('open');
}

userBtn.addEventListener('click', e => { e.stopPropagation(); openUserMenu(); });
userMenuOvl.addEventListener('click', closeUserMenu);

document.getElementById('um-sync').addEventListener('click', async ()=>{
  closeUserMenu();
  toast('同步中…');
  await syncVocab();
});
document.getElementById('um-logout').addEventListener('click', async ()=>{
  await SB.signOut();
  setAuthUI(null);
  closeUserMenu();
  toast('已退出登录');
  userBooks = [];
  renderUserBooks();
});

// ── 页面加载时恢复 session + 记录访问
(async () => {
  try {
    const user = await SB.restoreSession();
    if(user){
      setAuthUI(user);
      if(typeof window._syncFcSRS === 'function') window._syncFcSRS();
      if(typeof window._syncVpProgress === 'function') window._syncVpProgress();
    }
  } catch(e) { console.warn('session restore:', e.message); }
  await loadUserBooks();
  SB.rpc('record_visit').catch(()=>{});
})();

// ── 全局兜底：防止任何 unhandled rejection 显示为 "Script error."
window.addEventListener('unhandledrejection', e => {
  console.warn('Unhandled rejection:', e.reason);
  e.preventDefault();
});

// ── 离线检测
window.addEventListener('offline', () => toast('已离线，云端功能暂不可用'));
window.addEventListener('online',  () => toast('网络已恢复'));

// ── 禁止捏合缩放（PWA 应像原生 App，不缩放）
// iOS Safari 从 10 起故意忽略 viewport 的 user-scalable=no / maximum-scale（无障碍策略，
// 任何网页都无法通过 meta 标签关闭），CSS touch-action（html 上的 pan-x pan-y）配合
// gesturestart（Safari 私有事件，仅多指捏合手势触发，不影响单指滚动）已足以拦截捏合
// 缩放，无需额外注册会阻塞合成线程滚动的 document 级 touchmove 监听。
document.addEventListener('gesturestart', e => e.preventDefault());

// ── PWA: register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/Linggo/sw.js', { scope: '/Linggo/' })
      .catch(() => {});
  });
}

// ═══════════════════════════════════════════
//  HIGH-QUALITY TTS — engine priority:
//  0: Kokoro-82M server-side neural TTS (Hugging Face Spaces API, all platforms)
//  1: Microsoft Edge Neural WebSocket — non-iOS, skip after 2 failures
//  2: Best local SpeechSynthesis neural voice (Siri score=10, Enhanced=8, score≥5)
//  3: Google Translate TTS — non-iOS, skip after 2 failures
//  4: Any SpeechSynthesis voice (guaranteed fallback)
// ═══════════════════════════════════════════
let kokActive       = false;
let kokSession      = 0;
let kokWs           = null;
let kokAudio        = null;
let kokAudioDone    = null;
let _kokSynthCancel        = null;
let _kokSoftPaused         = false;
let _audioUnlocked         = false;
let _kokSynthToastShown    = false;
let _kokSrcShown           = '';
let _kokStartChar          = 0;   // 逐词跳转：首句从该字符起朗读，用后即清

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

(function _initKokLabel(){
  const name = document.getElementById('kok-hq-name');
  const sub  = document.getElementById('kok-ready-sub');
  if(!name || !sub) return;
  name.textContent = 'Kokoro 神经语音';
  sub.textContent  = '服务器神经语音 · 全平台可用';
})();

// Tell the user which engine is actually speaking (once per engine switch)
function _kokAnnounce(src){
  if(_kokSrcShown === src) return;
  _kokSrcShown = src;
  toast('语音源：' + src);
}

// Persistent gesture-blessed audio element.
// iOS WebKit requires EVERY Audio element to be activated by a user gesture
// — unlike Chrome, playing a silent clip on one element does NOT unlock
// others. So we create ONE element inside the click handler, play a silent
// WAV on it to bless it, then reuse it (swap .src) for every sentence.
let _kokAudioEl  = null;
let _kokAudioCtx = null;   // Web Audio context — created inside user gesture so iOS allows it

function _unlockAudio(){
  try{
    if(!_kokAudioEl){
      _kokAudioEl = new Audio();
      _kokAudioEl.setAttribute('playsinline','');
      _kokAudioEl.preload = 'auto';
    }
    // Create & resume AudioContext while the user gesture is still active.
    // iOS Safari locks AudioContext to 'suspended' when created outside a gesture.
    if(!_kokAudioCtx || _kokAudioCtx.state === 'closed')
      _kokAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(_kokAudioCtx.state === 'suspended')
      _kokAudioCtx.resume().catch(()=>{});
    if(_audioUnlocked) return;
    _audioUnlocked = true;
    // Minimal valid WAV: 1 channel, 44100 Hz, 16-bit, 1 silent sample
    _kokAudioEl.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQAEAAgAZGF0YQIAAAAA';
    _kokAudioEl.play().catch(()=>{});
    // iOS also gates speechSynthesis: the first speak() must happen inside
    // a user gesture or all later speak() calls are silently ignored.
    if('speechSynthesis' in window){
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  }catch(e){}
}

// ── Kokoro-82M server-side neural TTS ─────────────────────────────────────
// Runs on a Hugging Face Spaces FastAPI server (free, all platforms including iOS).
// HF Spaces free tier sleeps after 5 min of inactivity; cold start ~30-60 s.
// During warmup, P0 times out quickly (5 s) and falls through to Edge TTS /
// SpeechSynthesis; the background fetch populates KOK_DONE for the next sentence.
//
// Deploy: create a HF Space (sdk:docker) and replace KOK_SERVER_URL below.
const KOK_SERVER_URL = 'https://langhua1998-kokoro.hf.space';

let kokTTSReady = true;   // server always "ready"; cold-start handled by race timeout
const KOK_CACHE = new Map(); // synth key → Promise<blob URL>
const KOK_DONE  = new Map(); // synth key → blob URL (resolved & ready to play)
const KOK_ABORT = new Map(); // synth key → AbortController (in-flight /tts requests only)
const KOK_WORDS = new Map(); // synth key → [[word, startSec, endSec], …] for exact highlight

function _kokVoice(){ return S.kokVoice || (S.accentUS ? 'af_heart' : 'bf_emma'); }
function _kokKey(text){ return `${_kokVoice()}|${text}`; }

// NOTE: the previous Web-Audio /tts-stream player (_kokStreamPlay) was removed.
// It played through ctx.destination — a separate output from the gesture-blessed
// _kokAudioEl <audio> element — so togglePlay's pause() could not stop a scheduled
// source (it kept reading uncontrollably) and on iOS the Web-Audio output was often
// silent. Every Kokoro sentence now plays through _edgePlayUrl (<audio>) for uniform,
// controllable pause/resume/speed/highlight. First-sentence latency is covered by
// _kokServerSynth (/tts) + the 4-min /health keep-warm ping.

// ── Synth wait indicator (cold-start vs. generating) ─────────────────────
// HF Space sleeps after 5 min; the first synth then takes ~30-60 s. We must
// distinguish two slow cases so the label is honest:
//   • cold  — server is waking up (never synthesized this session, or idle
//             long enough to have slept) → "神经语音启动中" + countdown.
//   • gen   — server is warm but this sentence is still being generated
//             → "正在生成语音…" (spinner only, no countdown).
// Both keep awaiting the same in-flight request and play the instant it returns.
const _KOK_COLD_EST = 60;          // estimated cold-start seconds (countdown from)
let _kokColdTimer = null;
let _kokLastOkAt  = 0;             // ts of last successful synth (0 = never this session)
function _kokMaybeCold(){
  // Warm only if we've synthesized recently; HF sleeps after ~5 min idle.
  return _kokLastOkAt === 0 || (Date.now() - _kokLastOkAt) > 4 * 60 * 1000;
}
function _kokWaitShow(mode){       // mode: 'cold' | 'gen'
  const el = document.getElementById('kok-coldwait');
  if(!el) return;
  const txtEl = el.querySelector('.kcw-txt');
  const numEl = el.querySelector('.kcw-num');
  if(_kokColdTimer){ clearInterval(_kokColdTimer); _kokColdTimer = null; }
  if(mode === 'cold'){
    if(txtEl) txtEl.textContent = '神经语音启动中';
    if(numEl){ numEl.style.display = ''; }
    const t0 = Date.now();
    const tick = () => {
      const left = _KOK_COLD_EST - Math.floor((Date.now() - t0) / 1000);
      if(numEl) numEl.textContent = left > 0 ? left + 's' : '即将就绪';
    };
    tick();
    _kokColdTimer = setInterval(tick, 1000);
  } else {
    if(txtEl) txtEl.textContent = '正在生成语音…';
    if(numEl) numEl.style.display = 'none';
  }
  el.style.display = '';
}
function _kokWaitHide(){
  if(_kokColdTimer){ clearInterval(_kokColdTimer); _kokColdTimer = null; }
  const el = document.getElementById('kok-coldwait');
  if(el) el.style.display = 'none';
}

function _kokServerSynth(text){
  const key = _kokKey(text);
  if(KOK_DONE.has(key)) return Promise.resolve(KOK_DONE.get(key));
  if(KOK_CACHE.has(key)) return KOK_CACHE.get(key);
  const ac = new AbortController();
  KOK_ABORT.set(key, ac);
  const p = (async () => {
    try {
      const params = new URLSearchParams({
        text,
        voice: _kokVoice(),
        speed: '1'
      });
      // /tts-timed returns JSON { audio: base64 WAV, words: [[w,start,end],…] }
      // so we get exact per-word timing for the highlight. Falls back to /tts
      // (plain WAV) if the timed endpoint is unavailable.
      let url, words = null;
      const resp = await fetch(`${KOK_SERVER_URL}/tts-timed?${params}`, { signal: ac.signal });
      if(resp.ok && resp.status !== 204){
        const data = await resp.json();
        const bin  = atob(data.audio || '');
        const bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        words = Array.isArray(data.words) && data.words.length ? data.words : null;
      } else {
        const r2 = await fetch(`${KOK_SERVER_URL}/tts?${params}`, { signal: ac.signal });
        if(!r2.ok || r2.status === 204) throw new Error(`server ${r2.status}`);
        url = URL.createObjectURL(await r2.blob());
      }
      KOK_DONE.set(key, url);
      if(words) KOK_WORDS.set(key, words);
      KOK_ABORT.delete(key);
      _kokLastOkAt = Date.now();   // server proven warm — informs cold vs. gen label
      return url;
    } catch(e) {
      KOK_ABORT.delete(key);
      throw e;
    }
  })();
  KOK_CACHE.set(key, p);
  p.catch(() => KOK_CACHE.delete(key));
  if(KOK_CACHE.size > 40){
    const oldKey = KOK_CACHE.keys().next().value;
    Promise.resolve(KOK_CACHE.get(oldKey)).then(u => URL.revokeObjectURL(u)).catch(()=>{});
    const oldAc = KOK_ABORT.get(oldKey);
    if(oldAc){ try{ oldAc.abort(); }catch(e){} KOK_ABORT.delete(oldKey); }
    KOK_CACHE.delete(oldKey);
    KOK_DONE.delete(oldKey);
    KOK_WORDS.delete(oldKey);
  }
  return p;
}

function _kokPrefetch(n = 4){
  const stop = Math.min(S.idx + 1 + n, S.sents.length);
  for(let i = S.idx + 1; i < stop; i++){
    if(S.sents[i]) _kokServerSynth(S.sents[i]).catch(()=>{});
  }
}

// Eagerly pre-synthesize the sentence the user is most likely to play next
// (current + 1 ahead) BEFORE they press play, so the click hits the KOK_DONE
// cache and audio starts almost instantly. This is the main lever for low
// click-to-sound latency: synthesizing happens during the idle gap between
// opening a book / enabling Kokoro and pressing play. Pure network fetch — needs
// no user gesture (the gesture is only required to *play*). Also warms the HF
// Space pipeline so the very first real synthesis is just inference.
function _kokWarm(idx = S.idx){
  if(!kokActive) return;
  if(KOK_SERVER_URL === 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space') return;
  for(let i = idx; i < Math.min(idx + 2, S.sents.length); i++){
    if(S.sents[i]) _kokServerSynth(S.sents[i]).catch(()=>{});
  }
}
// Debounced variant for rapid idle navigation (scrubbing) — only the settled
// position gets synthesized, so we never backlog the 2-vCPU server.
let _kokWarmTimer = null;
function _kokWarmSoon(idx = S.idx){
  clearTimeout(_kokWarmTimer);
  _kokWarmTimer = setTimeout(() => _kokWarm(idx), 350);
}

const _EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// Correct endpoint is "readaloud" (per rany2/edge-tts) — NOT "realtimeaudio"
const _EDGE_WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  '?TrustedClientToken=' + _EDGE_TOKEN;

// Sec-MS-GEC DRM query param (required since 2024, else server returns 403):
// SHA-256( windows-file-time-in-100ns rounded down to 5 min + trusted token ),
// uppercase hex. It's a URL param, so browser JS CAN compute and send it.
let _gecCache = { exp: 0, val: '' };
async function _secMsGec(){
  const now = Math.floor(Date.now() / 1000);
  if(now < _gecCache.exp) return _gecCache.val;
  let sec = now + 11644473600;        // Unix epoch → Windows epoch (1601-01-01)
  sec -= sec % 300;                   // round down to 5-minute boundary
  const ticks = BigInt(sec) * 10000000n;  // seconds → 100-ns intervals (needs BigInt)
  const data  = new TextEncoder().encode(ticks.toString() + _EDGE_TOKEN);
  const hash  = await crypto.subtle.digest('SHA-256', data);
  const hex   = [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  _gecCache = { exp: now + 60, val: hex };
  return hex;
}

function _edgeVoice(){ return S.accentUS ? 'en-US-AriaNeural' : 'en-GB-SoniaNeural'; }
function _edgeRate(){
  const p = Math.round((S.speed - 1) * 100);
  return (p >= 0 ? '+' : '') + p + '%';
}
function _escXml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Per-engine failure counters: skip after 2 straight failures; reset on toggle.
let _edgeFails = 0;
let _gtFails   = 0;

// Clip text for URL-based TTS engines (~180 char server limits).
// lastIndexOf returns -1 when no space exists — handle explicitly.
function _clip180(text){
  if(text.length <= 180) return text;
  const cut = text.lastIndexOf(' ', 180);
  return text.slice(0, cut > 0 ? cut : 180);
}

// Google Translate TTS — no API key, works outside China. Non-iOS only.
function _gtUrl(text){
  const tl = S.accentUS ? 'en' : 'en-GB';
  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(_clip180(text))}`;
}

// Edge TTS WebSocket → Blob URL (caller must revoke)
async function _edgeSynth(text){
  if(!text.trim()) throw new Error('empty');
  const gec = await _secMsGec();
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const finish = (ok, val) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      if(ok) resolve(val); else reject(new Error(val));
    };
    const connId = crypto.randomUUID().replace(/-/g,'');
    const ws = new WebSocket(
      `${_EDGE_WSS}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${connId}`
    );
    ws.binaryType = 'arraybuffer';
    kokWs = ws;
    // Two-stage timeout: 4 s to connect, then 15 s for full synthesis.
    // Audio autoplay is already unlocked via _unlockAudio, so we are no
    // longer constrained by Chrome's 5 s gesture window.
    let timer = setTimeout(() => { ws.close(); finish(false, 'connect timeout'); }, 4000);
    ws.onopen = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { ws.close(); finish(false, 'synth timeout'); }, 15000);
      const ts  = new Date().toISOString();
      const rid = crypto.randomUUID().replace(/-/g,'');
      const lang = S.accentUS ? 'en-US' : 'en-GB';
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({context:{synthesis:{audio:{
          metadataoptions:{sentenceBoundaryEnabled:'false',wordBoundaryEnabled:'false'},
          outputFormat:'audio-24khz-48kbitrate-mono-mp3'
        }}}})
      );
      ws.send(
        `X-RequestId:${rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
        `<voice name='${_edgeVoice()}'>` +
        `<prosody pitch='+0Hz' rate='${_edgeRate()}' volume='+0%'>${_escXml(text)}</prosody>` +
        `</voice></speak>`
      );
    };
    ws.onmessage = e => {
      if(typeof e.data === 'string'){
        if(e.data.includes('Path:turn.end')){
          ws.close();
          chunks.length
            ? finish(true, URL.createObjectURL(new Blob(chunks, {type:'audio/mpeg'})))
            : finish(false, 'no audio');
        }
      } else {
        const hLen = new DataView(e.data).getUint16(0);
        const audio = e.data.slice(2 + hLen);
        if(audio.byteLength > 0) chunks.push(audio);
      }
    };
    ws.onerror = () => finish(false, 'ws error');
    ws.onclose = () => finish(false, 'closed');
  });
}

// Play an audio URL. Applies client-side speed via playbackRate + preservesPitch
// (pitch-preserved time-stretch — works on all modern browsers including iOS Safari).
// Optional sentEl: drives word-highlight via ontimeupdate as audio plays.
function _edgePlayUrl(url, sentEl, startChar = 0, words = null){
  return new Promise(resolve => {
    // Reuse the gesture-blessed element — REQUIRED on iOS: a freshly created
    // Audio element outside a user gesture is silently refused by WebKit.
    if(!_kokAudioEl){
      _kokAudioEl = new Audio();
      _kokAudioEl.setAttribute('playsinline','');
    }
    const a = _kokAudioEl;
    let done = false;
    let hlRaf = 0;
    const end = (ok) => {
      if(done) return;
      done = true;
      clearTimeout(guard);
      cancelAnimationFrame(hlRaf);
      a.onended = a.onerror = a.oncanplay = a.ontimeupdate = null;
      // Only pause the element if this call still owns it. A stale end(false)
      // from a previous sentence's guard/error must not pause a new sentence's
      // audio that has already set a.src to a different URL.
      if(!ok && a.src === url){ try{ a.pause(); }catch(e){} }
      kokAudio = null; kokAudioDone = null;
      resolve(ok);
    };
    kokAudio = a; kokAudioDone = end;
    // Pitch-preserved speed control (playbackRate=2 plays twice as fast, no chipmunk effect)
    a.preservesPitch = a.mozPreservesPitch = a.webkitPreservesPitch = true;
    a.playbackRate = S.speed || 1;
    // Stall guard: detects a truly frozen server (currentTime stops advancing)
    // without misfiring on a user soft-pause or a brief network hiccup.
    // • Paused: re-arm for 60 s so the guard can't fire immediately after resume.
    // • Playing and making progress: re-arm for 30 s.
    // • Playing but currentTime stuck: real stall → end(false).
    let lastStallTime = -1;
    const stall = () => {
      if(a.paused && !a.ended){ guard = setTimeout(stall, 60000); return; }
      const ct = a.currentTime;
      if(ct > lastStallTime){ lastStallTime = ct; guard = setTimeout(stall, 30000); return; }
      end(false);
    };
    let guard = setTimeout(stall, 6000);
    let seekDone = false;
    a.oncanplay = () => {
      clearTimeout(guard);
      lastStallTime = -1;   // reset progress baseline after load
      guard = setTimeout(stall, 30000);
      // Some browsers reset playbackRate on src change; re-apply on canplay
      a.playbackRate = S.speed || 1;
      // Mid-sentence word-jump: seek to the proportional time offset so audio
      // starts at the right word and the highlight formula stays correct.
      if(startChar > 0 && !seekDone && isFinite(a.duration) && a.duration > 0){
        const tl = (a._sentText || '').length || (sentEl ? sentEl.textContent.length : 0);
        if(tl > 0){ seekDone = true; a.currentTime = (startChar / tl) * a.duration; }
      }
    };
    a.onended = () => end(true);
    a.onerror = () => end(false);
    if(sentEl){
      // Smooth word highlight: poll currentTime every animation frame (~60fps)
      // instead of the browser's ~4/s `timeupdate` event, which made the
      // highlight advance in visible ~250 ms steps and feel laggy. A small lead
      // offset keeps the highlight sitting on / just ahead of the audio rather
      // than trailing it. Only re-runs highlightWordAt when the word changes.
      const sentText = sentEl.textContent;
      const tl = sentText.length;
      const wordEls = [...sentEl.querySelectorAll('.word[data-char-start]')];
      const LEAD = 0.12;   // seconds — perceptual sync compensation (120 ms)
      // Exact path: map each Kokoro token to a char offset in the sentence
      // (located in order) so we can drive the existing char→word highlight
      // by real timestamps. Null when the server returned no word timings.
      let timed = null;
      if(words && words.length){
        timed = []; let cursor = 0;
        for(const wd of words){
          const idx = sentText.indexOf(wd[0], cursor);
          if(idx >= 0){ timed.push([idx, wd[1]]); cursor = idx + wd[0].length; }
        }
        if(!timed.length) timed = null;
      }
      let lastCs = -1;
      const track = () => {
        if(done) return;
        const dur = a.duration;
        if(dur && !a.paused){
          const t = a.currentTime + LEAD;
          let cs = -1;
          if(timed){
            // exact: last token whose start time has passed
            for(const [charStart, ws] of timed){ if(ws > t) break; cs = charStart; }
          } else {
            // fallback: linear char position proportional to elapsed time
            const charIdx = Math.min(Math.floor((Math.min(t, dur) / dur) * tl), tl - 1);
            for(const el of wordEls){ if(+el.dataset.charStart > charIdx) break; cs = +el.dataset.charStart; }
          }
          if(cs >= 0 && cs !== lastCs){ lastCs = cs; highlightWordAt(sentEl, cs); }
        }
        hlRaf = requestAnimationFrame(track);
      };
      hlRaf = requestAnimationFrame(track);
    }
    a.src = url;
    a.play().catch(err => {
      // AbortError caused by the user calling .pause() is a soft-pause, not a
      // failure. The audio will resume when the user presses play again; the
      // stall guard and onended will settle the promise then. Treating it as a
      // failure would resolve end(false) and fall through to a system-voice
      // fallback that plays simultaneously with the Kokoro audio on resume.
      if(err && err.name === 'AbortError' && a.paused) return;
      end(false);
    });
  });
}

// SpeechSynthesis playback — uses getVoice() to pick the best voice,
// avoiding Google TTS (blocked in China) and preferring Siri / Edge Neural.
// kokStop() can abort via _kokSynthCancel.
function _synthPlay(text, forceVoice){
  return new Promise(resolve => {
    if(!('speechSynthesis' in window)){ resolve(false); return; }
    let done = false;
    let startGuard = null;
    let speakCheck = null;
    const end = (ok) => {
      if(done) return;
      done = true;
      clearTimeout(t);
      clearTimeout(startGuard);
      clearTimeout(speakCheck);
      _kokSynthCancel = null;
      try{ window.speechSynthesis.cancel(); }catch(e){}
      resolve(ok);
    };
    _kokSynthCancel = () => end(false);
    const t = setTimeout(() => end(false), 90000);

    // iOS WebKit: onstart is unreliable (often never fires) — don't use it as
    // the sole gate. Instead poll speechSynthesis.speaking 2 s after speak().
    // Non-iOS / pre-unlock: onstart guard still catches gesture-gated speech.
    if(_audioUnlocked && IS_IOS){
      speakCheck = setTimeout(() => {
        if(!window.speechSynthesis.speaking) end(false);
      }, 2000);
    } else {
      startGuard = setTimeout(() => end(false), 4000);
    }

    const u = new SpeechSynthesisUtterance(text);
    u.lang  = S.accentUS ? 'en-US' : 'en-GB';
    u.rate  = S.speed || 1;
    const v = forceVoice || getVoice();
    if(v) u.voice = v;
    u.onstart = () => { clearTimeout(startGuard); clearTimeout(speakCheck); };
    u.onend   = () => end(true);
    u.onerror = () => end(false);
    window.speechSynthesis.speak(u);
  });
}

// Synthesise + play one sentence; true = done, false = stop-was-called
async function _edgePlayOne(text, mySession, startChar = 0){
  // Soft-paused during the synth gap between sentences: stop cleanly instead of
  // starting a new playback (which would auto-play a fallback engine while the
  // user has it paused). kokPlay keeps S.idx so resume replays this sentence.
  if(S.paused) return 'paused';
  // Sentence element for word-highlight — resolved once, shared by all engines.
  const _hlEl = document.querySelector(`.sent[data-i="${S.idx}"]`);
  // ── Priority 0: Kokoro server neural TTS ─────────────────────────────────
  // HF Spaces may be cold-starting (~30-60 s). If this sentence is already
  // in KOK_CACHE (prefetched), wait 30 s — server will finish soon.
  // If starting fresh, race with 8 s timeout so a sleeping HF Space falls
  // through to the online engines instead of hanging the reader.
  if(kokTTSReady && KOK_SERVER_URL !== 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space'){
    try {
      let url = KOK_DONE.get(_kokKey(text));
      if(S.paused) return 'paused';   // paused between function entry and cache check
      if(!url){
        // Give the (maybe warm) server a short window first.
        url = await Promise.race([
          _kokServerSynth(text).catch(() => null),
          new Promise(r => setTimeout(() => r('__cold__'), 5000))
        ]);
        if(url === '__cold__'){
          // No response in 5 s. Keep awaiting the SAME in-flight request
          // (memoized by key) so we play the instant it returns. Label it
          // honestly: cold-start countdown only if the server is actually
          // waking up; otherwise it's just normal generation latency.
          url = null;
          _kokWaitShow(_kokMaybeCold() ? 'cold' : 'gen');
          try {
            url = await Promise.race([
              _kokServerSynth(text),
              new Promise((_, rej) => setTimeout(() => rej(0), 90000))
            ]);
          } catch(e) { url = null; }
          _kokWaitHide();
        }
        if(kokSession !== mySession){ _kokWaitHide(); return false; }
        if(S.paused){ _kokWaitHide(); return 'paused'; }   // user paused while synthesizing
      }
      if(url){
        _kokAnnounce('Kokoro 神经语音（服务器）');
        _kokPrefetch();  // warm upcoming sentences while this one plays
        if(await _edgePlayUrl(url, _hlEl, startChar, KOK_WORDS.get(_kokKey(text)))) return true;
        if(kokSession !== mySession) return false;
      } else if(!_kokSynthToastShown){
        _kokSynthToastShown = true;
        toast('神经语音服务启动中，暂以在线语音播放');
      }
    } catch(e) { _kokWaitHide(); /* fall through to online engines */ }
  }

  let url = null;
  let isBlobUrl = false;
  try {
    // ── P1: Edge Neural WebSocket (Aria/Sonia) — non-iOS only ────────────
    // On iOS every browser is WebKit; Apple's own neural Siri voices via
    // speechSynthesis are higher quality than Edge and need zero network.
    if(S.paused) return 'paused';
    if(!IS_IOS && _edgeFails < 2){
      try {
        url = await _edgeSynth(text);
        isBlobUrl = true;
      } catch(e) {
        kokWs = null;
        // kokStop() closes the socket mid-synthesis (user pressed pause/next)
        // — that is a user-initiated cancel, not an engine failure.
        if(kokSession !== mySession) return false;
        _edgeFails++;
        if(_edgeFails >= 2){
          toast(`Edge神经语音不可用（${e && e.message || '未知'}），切换备用源`);
        }
      }
    }
    kokWs = null;
    if(kokSession !== mySession) return false;
    if(S.paused) return 'paused';

    if(url){
      _kokAnnounce('Microsoft 神经语音（在线）');
      const edgeOk = await _edgePlayUrl(url, _hlEl);
      if(edgeOk){ _edgeFails = 0; return true; }
      if(kokSession !== mySession) return false;
    }

    // ── P2: Best local SpeechSynthesis neural voice ───────────────────────
    // iPhone: Siri (score 10) or Apple Enhanced (score 8) — instant, offline.
    // Edge browser (desktop): Azure Neural voices (score 5+).
    if(S.paused) return 'paused';
    const bestVoice = getVoice();
    if(bestVoice && qualityScore(bestVoice) >= 5){
      if(kokSession !== mySession) return false;
      _kokAnnounce(`系统神经语音（${bestVoice.name}）`);
      if(await _synthPlay(text, bestVoice)) return true;
      if(kokSession !== mySession) return false;
    }

    // ── P3: Google Translate TTS — non-iOS, <2 failures ──────────────────
    if(S.paused) return 'paused';
    if(!IS_IOS && _gtFails < 2){
      if(kokSession !== mySession) return false;
      _kokAnnounce('Google 在线语音');
      const gtOk = await _edgePlayUrl(_gtUrl(text));
      if(gtOk){ _gtFails = 0; return true; }
      _gtFails++;
    }

    // ── P4: Any SpeechSynthesis voice (guaranteed fallback) ──────────────
    if(S.paused) return 'paused';
    if(kokSession !== mySession) return false;
    _kokAnnounce('系统语音');
    return await _synthPlay(text);
  } finally {
    if(isBlobUrl && url) URL.revokeObjectURL(url);
  }
}

function kokStop(){
  _kokSoftPaused = false;
  kokSession++;
  _kokWaitHide();   // drop any wait indicator — request is being aborted
  // Abort all in-flight /tts prefetch requests so the HF Space (2 vCPU) is freed
  // immediately — otherwise a voice/speed switch queues behind ~4 stale requests
  // (~20 s) and looks like a cold start.
  KOK_ABORT.forEach(ac => { try{ ac.abort(); }catch(e){} });
  KOK_ABORT.clear();
  KOK_CACHE.clear();  // drop stale in-flight promises; KOK_DONE keeps completed URLs
  if(kokWs){ try{ kokWs.close(); }catch{} kokWs = null; }
  if(kokAudio){ kokAudio.pause(); kokAudio = null; }
  if(kokAudioDone){ kokAudioDone(false); kokAudioDone = null; }
  if(_kokSynthCancel){ _kokSynthCancel(); _kokSynthCancel = null; }
}

async function kokPlay(){
  const mySession = ++kokSession;
  let startChar = _kokStartChar; _kokStartChar = 0;   // 仅首句生效
  S.playing = true; S.paused = false; setIcon(true);
  while(S.idx < S.sents.length){
    if(kokSession !== mySession) break;
    jump(S.idx);
    if(startChar > 0){                          // 逐词跳转的起始词：立即高亮（无逐词事件）
      const el = document.querySelector(`.sent[data-i="${S.idx}"]`);
      if(el){ injectWords(el); highlightWordAt(el, startChar); }
    }
    const text = S.sents[S.idx];          // always full sentence — seek handles start offset
    const sc = startChar; startChar = 0;
    const ok = await _edgePlayOne(text, mySession, sc);
    if(kokSession !== mySession) break;
    if(ok === 'paused') return;   // 软暂停发生在合成间隙：干净停在当前句，恢复时重播
    if(!ok){
      S.playing = false; S.paused = false; setIcon(false);
      toast('朗读已停止：所有语音引擎暂不可用，请稍后重试');
      return;
    }
    S.idx++;
  }
  if(kokSession === mySession){
    S.playing = false; S.paused = false; setIcon(false); saveProg();
    // Reached the end of the book → celebrate
    if(S.idx >= S.sents.length) confettiBurst({ y: window.innerHeight * 0.32 });
  }
}

document.getElementById('kok-toggle').addEventListener('change', e => {
  kokActive = e.target.checked;
  _audioUnlocked      = false;
  _kokSynthToastShown = false;
  _kokSrcShown        = '';
  _edgeFails          = 0;
  _gtFails            = 0;
  if(!kokActive && (S.playing || S.paused)){
    synth.cancel(); stopResumeTimer();
    kokStop(); S.playing = false; S.paused = false; setIcon(false);
  }
  if(kokActive){
    const deployed = KOK_SERVER_URL !== 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space';
    toast(deployed ? '高音质已开启（Kokoro 神经语音服务器）' : '高音质已开启（Microsoft / Apple 神经语音）');
    _unlockAudio();
    // If system voice was playing, hand off to Kokoro immediately
    if(S.playing || S.paused){
      synth.cancel(); stopResumeTimer();
      S.paused = false; S.playing = false;
      kokPlay();
    } else {
      _kokWarm();   // warm current sentence now so the next play click is instant
    }
  } else {
    toast('已切换回系统语音');
  }
  _syncKokVoiceRow();
});

function _syncKokVoiceRow(){
  const row = document.getElementById('kok-voice-row');
  if(!row) return;
  row.style.display = kokActive ? '' : 'none';
}

(function _initKokVoice(){
  const sel = document.getElementById('kok-voice-select');
  if(!sel) return;
  const saved = localStorage.getItem('kokVoice');
  if(saved && sel.querySelector(`option[value="${saved}"]`)){
    S.kokVoice = saved;
  }
  sel.value = S.kokVoice;
  S.accentUS = S.kokVoice[0] === 'a';   // a*=美式, b*=英式 — keep fallbacks aligned
  sel.addEventListener('change', function(){
    S.kokVoice = this.value;
    S.accentUS = this.value[0] === 'a';
    localStorage.setItem('kokVoice', this.value);
    toast('音色已切换：' + this.options[this.selectedIndex].text.replace(/[（(].*$/, '').trim());
    // Revoke all cached audio for the old voice (keys include the voice name).
    // KOK_DONE holds completed blob URLs that kokStop() deliberately keeps, but
    // they become unreachable under a new voice prefix — revoke now to avoid leak.
    KOK_DONE.forEach(u => { try{ URL.revokeObjectURL(u); }catch(e){} });
    KOK_DONE.clear();
    KOK_WORDS.clear();
    // If currently reading with Kokoro, restart the sentence so the new
    // voice takes over immediately instead of after the cached audio ends.
    if(kokActive && (S.playing || S.paused)){
      kokStop(); kokPlay();
    }
  });
})();

// Ping HF Space every 4 min while page is visible to prevent cold-start sleep
setInterval(() => {
  if(document.visibilityState === 'visible' &&
     KOK_SERVER_URL !== 'https://YOUR_HF_USERNAME-kokoro-tts.hf.space')
    fetch(`${KOK_SERVER_URL}/health`, {mode:'no-cors'}).catch(()=>{});
}, 4 * 60 * 1000);
