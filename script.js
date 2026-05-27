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
  [1260,"The Mysterious Island","Jules Verne",1874,["adventure","scifi"],"Chapter 1"],
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

// Category labels
const CAT_LABELS = {all:'全部',classic:'经典',mystery:'推理',adventure:'冒险',scifi:'科幻',horror:'恐怖',short:'短篇'};
let libCat = 'all', libQuery = '';

// ── Cover URL
function coverUrl(isbn){ return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`; }
function gbCoverUrl(id){ return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`; }

// ── CORS proxies with real progress tracking
const CORS_PROXIES = [
  u => u,  // 直连（Gutenberg 支持 CORS，国外网络优先）
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

async function fetchWithProgress(rawUrl, onProgress){
  for(const mk of CORS_PROXIES){
    try{
      const ctrl = new AbortController();
      const tid  = setTimeout(()=>ctrl.abort(), 20000);
      const resp = await fetch(mk(rawUrl), {signal:ctrl.signal});
      clearTimeout(tid);
      if(!resp.ok) continue;
      const total  = parseInt(resp.headers.get('content-length')||'0');
      const reader = resp.body.getReader();
      const chunks = []; let got = 0;
      while(true){
        const {done,value} = await reader.read();
        if(done) break;
        chunks.push(value); got += value.length;
        const pct = total > 0 ? Math.round(got/total*100) : Math.min(90, Math.round(got/5000));
        onProgress(pct);
      }
      onProgress(100);
      const buf = new Uint8Array(got); let pos=0;
      for(const c of chunks){ buf.set(c,pos); pos+=c.length; }
      return new TextDecoder('utf-8').decode(buf);
    }catch(e){ console.warn('proxy fail',e); }
  }
  throw new Error('all proxies failed');
}

// ── Card state manager
function setCardAction(cardEl, state, pct){
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
  const [c1,c2] = book.pal;
  const hasIsbn = book.isbn && book.isbn !== 'null';
  const imgSrc  = hasIsbn ? coverUrl(book.isbn)
                : book._gbId ? gbCoverUrl(book._gbId)
                : null;
  div.innerHTML = `
    <div class="bk-cover">
      ${imgSrc ? `<img src="${imgSrc}" alt="${book.t}" loading="lazy">` : ''}
      <div class="bk-cover-fallback" style="${imgSrc?'display:none;':'display:flex;'}background:linear-gradient(145deg,${c1},${c2})">
        <div class="bk-fb-title">${book.t}</div>
        <div class="bk-fb-author">${book.a.split(' ').pop()}</div>
        <div class="bk-fb-deco"></div>
      </div>
    </div>
    <div class="bk-title">${book.t}</div>
    <div class="bk-author">${book.a}</div>
    <div class="bk-action"></div>`;

  if(imgSrc){
    const img = div.querySelector('img');
    const fb  = div.querySelector('.bk-cover-fallback');
    img.onerror = () => { img.style.display='none'; fb.style.display='flex'; };
  }

  // check local cache, set initial button state
  setCardAction(div, 'init');
  idbHas(book.url).then(has => setCardAction(div, has ? 'cached' : 'ready'));

  return div;
}

// ── Load book: try cache first, then download
async function loadBook(book, cardEl){
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
    setCardAction(cardEl, 'error', book.url);
  }
}

// ── Open book in reader
function openBook(book, text){
  S.fileName = book.t;
  document.getElementById('filename').textContent = book.t;
  loadProg();
  document.getElementById('library').classList.remove('open');
  document.getElementById('overlay').classList.remove('vis');
  buildReader(text);
  toast('《' + book.t + '》');
}

// ── Render library rows
function renderLib(){
  BOOKS.forEach((level, li) => {
    const row = document.getElementById(`lib-row-${li}`);
    if(!row) return;
    row.innerHTML = '';
    const filtered = level.filter(b => {
      const catOk = libCat === 'all' || b.cat.includes(libCat);
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

// ── Search
let libSearchTimer;
document.getElementById('lib-search').addEventListener('input', e => {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => { libQuery = e.target.value.trim(); renderLib(); }, 200);
});

// ── Category tab bar
document.querySelectorAll('.lcat').forEach(btn => {
  btn.addEventListener('click', () => {
    libCat = btn.dataset.cat;
    document.querySelectorAll('.lcat').forEach(b => b.classList.toggle('on', b === btn));
    renderLib();
  });
});

// ── Library open/close
document.getElementById('lib-tbtn').addEventListener('click', () => {
  document.getElementById('library').classList.toggle('open');
});
document.getElementById('lib-open-btn').addEventListener('click', () => {
  document.getElementById('library').classList.add('open');
});
document.getElementById('lib-close').addEventListener('click', () => {
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
  night:false, trans:{},
  curWordEl:null, curWordData:null,
  selectedVoice:null, savedWords:new Set(),
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
    fontSize:S.fontSize, night:S.night,
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
    S.accentUS   = d.accentUS !== undefined ? d.accentUS : true;
    S.mode       = d.mode       || 'normal';
    S.lineHeight = d.lineHeight || 2.05;
    S.textAlign  = d.textAlign  || 'left';
  }
  const v = localStorage.getItem('vocab');
  if(v) S.vocab = JSON.parse(v);
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
  const n = v.name.toLowerCase();
  if(n.includes('siri'))     return 10;
  if(n.includes('enhanced')) return 9;
  if(n.includes('premium'))  return 8;
  if(n.includes('natural'))  return 5;
  if(n.includes('compact'))  return 0;
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
    .filter(v => v.lang.startsWith('en') && !BLOCK.test(v.name))
    .sort((a,b)=>{
      const au = a.lang==='en-US'?1:0, bu = b.lang==='en-US'?1:0;
      if(au!==bu) return bu-au;
      return qualityScore(b)-qualityScore(a);
    });
  if(!enVoices.length) return;
  const sel = document.getElementById('sb-voice-select');
  if(!sel) return;
  sel.innerHTML = '';
  enVoices.forEach(v=>{
    const o = document.createElement('option');
    o.value = v.name;
    const flag = v.lang==='en-US'?'🇺🇸':v.lang==='en-GB'?'🇬🇧':'🌐';
    o.textContent = flag+' '+cleanVoiceName(v);
    sel.appendChild(o);
  });
  const saved = localStorage.getItem('selectedVoice');
  const savedVoice = saved && enVoices.find(v=>v.name===saved);
  if(savedVoice){ sel.value=savedVoice.name; S.selectedVoice=savedVoice; }
  else{
    S.selectedVoice = enVoices[0];
    sel.value = enVoices[0].name;
    localStorage.setItem('selectedVoice', enVoices[0].name);
  }
}
document.getElementById('sb-voice-select').addEventListener('change', function(){
  S.selectedVoice = allVoices.find(v=>v.name===this.value)||null;
  localStorage.setItem('selectedVoice', this.value);
});
document.getElementById('sb-voice-preview').addEventListener('click', ()=>{
  const u = new SpeechSynthesisUtterance('Hello! This is a voice preview.');
  u.rate = S.speed;
  if(S.selectedVoice) u.voice = S.selectedVoice;
  synth.cancel(); synth.speak(u);
});
synth.onvoiceschanged = ()=>{ populateVoices(); };
populateVoices();

// ═══════════════════════════════════════════
//  FILE LOADING (from local TXT upload)
// ═══════════════════════════════════════════
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
  // Step 1: split on sentence-ending punctuation (.!?) and semicolons
  const raw = txt.match(/[^.!?;]+[.!?;]+['""\u201d]?\s*|[^.!?;]+$/g) || [txt];

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
  return result.filter(s => s.length > 2);
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

// ── MOBILE (touch) ──────────────────────────
// Non-passive touchstart: e.preventDefault() blocks iOS long-press menu
area.addEventListener('touchstart', function(e){
  const sentEl = e.target.closest('.sent');
  if(!sentEl) return;

  e.preventDefault(); // ← blocks browser text-selection callout
  touchActive = true;
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
}, { passive: false }); // ← must be non-passive to call preventDefault

area.addEventListener('touchmove', ()=>{
  clearTimeout(pressTimer); // cancel long-press if finger moves (scroll)
}, { passive: true });

area.addEventListener('touchend', function(e){
  clearTimeout(pressTimer);
  touchActive = true;
  if(!pressFired){
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
  S.sents = []; S.trans = {}; S.chapters = [];
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
    set: (k, v) => { mem[k] = v; try { sessionStorage.setItem('tl_cache', JSON.stringify(mem)); } catch(e) {} }
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
    const r = await fetchTimed(`https://lingva.ml/api/v1/en/zh/${encodeURIComponent(txt.slice(0, 300))}`);
    const d = await r.json();
    if (d.translation) { TRANS_CACHE.set(cacheKey, d.translation); return d.translation; }
  } catch(e) {}

  return '[翻译失败，请检查网络]';
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
  wpop.classList.add('vis');

  // async: dictionary → POS + meaning in Chinese
  try{
    const r = await fetch(
      'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)
    );
    if(!r.ok) throw new Error('dict ' + r.status);
    const entry = (await r.json())[0];

    const ph = entry.phonetics?.find(p => p.text)?.text || '';
    const au = entry.phonetics?.find(p => p.audio?.length > 0)?.audio || '';
    document.getElementById('wp-ph').textContent = ph;
    wpop._audio = au;

    const rawPos = entry.meanings?.[0]?.partOfSpeech || '';
    const zhPos  = POS_ZH[rawPos] || rawPos;
    if(zhPos){ posEl.textContent = zhPos; posEl.style.display = ''; }

    const enDef = entry.meanings?.[0]?.definitions?.[0]?.definition || '';
    wpop._meaning = enDef;
    const src = enDef || word;
    const zh  = await translate(src);
    if(document.getElementById('wp-word').textContent === word){
      meaningEl.textContent = zh;
      meaningEl.className   = 'wp-meaning';
      wpop._meaning = zh;
    }
  }catch{
    meaningEl.textContent = '—';
    meaningEl.className   = 'wp-meaning';
  }
}

document.getElementById('wp-close').addEventListener('click', () => {
  wpop.classList.remove('vis');
  document.querySelectorAll('.word.active').forEach(w => w.classList.remove('active'));
});
document.getElementById('wp-spk').addEventListener('click', () => {
  const w = document.getElementById('wp-word').textContent;
  if(wpop._audio) new Audio(wpop._audio).play().catch(() => speakWord(w));
  else speakWord(w);
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
  const w = document.getElementById('wp-word').textContent;
  if(wpop._audio) new Audio(wpop._audio).play().catch(()=> speakWord(w));
  else speakWord(w);
});
document.addEventListener('click', e => {
  if(!wpop.contains(e.target) && !e.target.classList.contains('word')){
    wpop.classList.remove('vis');
    document.querySelectorAll('.word.active').forEach(w=>w.classList.remove('active'));
  }
});
function speakWord(w){
  const u = new SpeechSynthesisUtterance(w);
  u.lang = S.accentUS ? 'en-US' : 'en-GB'; u.rate = 0.85;
  synth.cancel(); synth.speak(u);
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
function renderVoc(){
  const list=document.getElementById('voc-list');
  document.getElementById('voc-ct').textContent=S.vocab.length+' 词';
  if(!S.vocab.length){
    list.innerHTML='<div style="text-align:center;padding:48px 0;color:var(--text-3);font-size:14px;">点击单词后点「收藏」<br>或长按单词快速添加</div>';
    return;
  }
  list.innerHTML=S.vocab.map((v,i)=>`
    <div class="vi">
      <div class="vi-w">${v.word}</div>
      ${v.meaning?`<div class="vi-m">${v.meaning.slice(0,80)}</div>`:''}
      ${v.sent?`<div class="vi-s">${v.sent.trim().slice(0,100)}…</div>`:''}
      <div class="vi-row">
        <span class="vi-d">${new Date(v.time).toLocaleDateString('zh-CN')}</span>
        <button class="vi-del" data-i="${i}">🗑</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.vi-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=+btn.dataset.i, w=S.vocab[i].word;
      S.vocab.splice(i,1);
      document.querySelectorAll(`.word[data-w="${w}"]`).forEach(el=>el.classList.remove('saved'));
      cloudDeleteVocab(w); // 云端同步（静默）
      renderVoc(); saveProg();
    });
  });
}
document.getElementById('voc-tbtn').addEventListener('click',()=>{ document.getElementById('voc').classList.add('open'); document.getElementById('overlay').classList.add('vis'); });
document.getElementById('voc-close').addEventListener('click',closeVoc);
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
  S.idx = i;
  const el = document.querySelector(`.sent[data-i="${i}"]`);
  if(el){
    el.classList.add('playing');
    // Inject words so highlighting works
    injectWords(el);
    el.scrollIntoView({behavior:'smooth', block:'center'});
  }
  document.getElementById('sent-preview-text').textContent = S.sents[i] || '';
  updateProg(); saveProg();
}

// Build a chunk: join sentences into one utterance, track char offsets per sentence
function buildChunk(startIdx){
  const MAX_CHARS = 300; // keep chunks short for responsiveness
  const offsets = []; // char position where each sentence starts
  const parts = [];
  let pos = 0, i = startIdx;
  while(i < S.sents.length){
    const s = S.sents[i];
    if(parts.length > 0 && pos + s.length > MAX_CHARS) break;
    offsets.push(pos);
    parts.push(s);
    pos += s.length + 1;
    i++;
  }
  return { text: parts.join(' '), offsets, endIdx: i, startIdx };
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

    // 2. Char position within this sentence
    const sentCharIdx = e.charIndex - chunk.offsets[si];

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
}

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
  synth.cancel(); stopResumeTimer();
  S.paused = false;
  const chunk = buildChunk(S.idx);
  jump(S.idx);
  S.playing = true; setIcon(true); startResumeTimer();
  synth.speak(playChunk(chunk));
}

function togglePlay(){
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
  document.getElementById('play-ico').outerHTML = playing
    ? `<svg id="play-ico" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/></svg>`
    : `<svg id="play-ico" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><polygon points="6 3 20 12 6 21"/></svg>`;
}

document.getElementById('play-btn').addEventListener('click', togglePlay);

document.getElementById('prev-btn').addEventListener('click',()=>{
  if(S.idx>0){ S.idx--; jump(S.idx); if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); } }
});
document.getElementById('next-btn').addEventListener('click',()=>{
  if(S.idx<S.sents.length-1){ S.idx++; jump(S.idx); if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); } }
});

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
    if(S.playing||S.paused){ synth.cancel(); stopResumeTimer(); S.paused=false; S.playing=false; setIcon(false); playCurrent(); }
  });
});

function applySpeed(s){
  S.speed = s;
  speedBtn.textContent = s + 'x';
  document.querySelectorAll('.spill').forEach(b => b.classList.toggle('on', +b.dataset.s === s));
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
function restoreProg(){
  if(S.idx>0&&S.idx<S.sents.length){
    setTimeout(()=>{ jump(S.idx); toast(`已恢复 ${Math.round(S.idx/S.sents.length*100)}% 进度`); },400);
  }
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
//  FLASHCARD SYSTEM — SRS + Swipe + Animations
// ═══════════════════════════════════════════
const SRS_INTERVALS = { again: 10*60*1000, hard: 86400000, good: 3*86400000, easy: 7*86400000 };
const FC_CACHE = new Map(); // word → { phonetic, audio, pos, enDef }

let fcDeck      = [];
let fcIdx       = 0;
let fcFlipped   = false;
let fcCounts    = { again:0, hard:0, good:0, easy:0 };
let fcTotal     = 0;
let fcOrigTotal = 0;   // session 开始时原始卡片数（不含 again 重排）
let fcDoneCount = 0;   // 已完成卡片数（非 again 评分的累计）
let fcSRS       = {};  // word → { nextReview, interval }
let fcMode      = 'book'; // 'book' | 'deck'

// ── 动态间隔计算（类 Anki：间隔随正确次数成倍增长）
function calcNextInterval(rating, prevInterval){
  if(rating === 'again') return SRS_INTERVALS.again;
  if(rating === 'hard')  return Math.round(Math.max(SRS_INTERVALS.hard, (prevInterval || SRS_INTERVALS.hard)  * 1.2));
  if(rating === 'good')  return Math.round(Math.max(SRS_INTERVALS.good, (prevInterval || SRS_INTERVALS.good)  * 2.5));
  if(rating === 'easy')  return Math.round(Math.max(SRS_INTERVALS.easy, (prevInterval || SRS_INTERVALS.easy)  * 4.0));
  return SRS_INTERVALS.good;
}
function fmtInterval(ms){
  const m = Math.round(ms/60000);
  if(m < 60)   return m + '分钟';
  const h = Math.round(ms/3600000);
  if(h < 24)   return h + '小时';
  const d = Math.round(ms/86400000);
  if(d < 30)   return d + '天';
  return Math.round(d/30) + '个月';
}

// ── Vocab deck progress
let vpProgress = {};  // word → { nextReview, correct, wrong }
let vpDeck     = 'cet4';
let vpCount    = 10;

function loadVpProgress(deck){
  try{ vpProgress = JSON.parse(localStorage.getItem('vp_'+deck)||'{}'); }catch(e){ vpProgress={}; }
}
function saveVpProgress(deck){
  localStorage.setItem('vp_'+deck, JSON.stringify(vpProgress));
}
async function syncVpFromSupabase(deck){
  if(!currentUser) return;
  try{
    const rows = await SB.selectVocabProgress(currentUser.id, deck);
    rows.forEach(r=>{
      vpProgress[r.word] = { nextReview: new Date(r.next_review).getTime(), correct: r.correct_count||0, wrong: r.wrong_count||0 };
    });
    saveVpProgress(deck);
  }catch(e){}
}
async function pushVpWord(deck, word){
  if(!currentUser) return;
  const p = vpProgress[word] || { nextReview: Date.now(), correct: 0, wrong: 0 };
  try{ await SB.upsertVocabProgress(currentUser.id, deck, word, p); }catch(e){}
}

function loadSRS(){
  try{ fcSRS = JSON.parse(localStorage.getItem('fc_srs')||'{}'); }catch(e){ fcSRS={}; }
}
function saveSRS(){
  localStorage.setItem('fc_srs', JSON.stringify(fcSRS));
}

function openFlashcard(){
  if(!S.vocab.length){ toast('生词本是空的，先去收藏一些单词！'); return; }
  loadSRS();
  closeVoc();

  // Build deck: due cards first, then new cards, shuffled within each group
  const now = Date.now();
  const due = S.vocab.filter(v => fcSRS[v.word] && fcSRS[v.word].nextReview <= now);
  const newW = S.vocab.filter(v => !fcSRS[v.word]);
  const later = S.vocab.filter(v => fcSRS[v.word] && fcSRS[v.word].nextReview > now);

  // Shuffle each group
  const shuffle = arr => [...arr].sort(()=>Math.random()-.5);
  fcDeck = [...shuffle(due), ...shuffle(newW), ...shuffle(later)];
  fcIdx  = 0; fcFlipped = false;
  fcCounts = {again:0,hard:0,good:0,easy:0};
  fcTotal     = fcDeck.length;
  fcOrigTotal = fcDeck.length;
  fcDoneCount = 0;

  const fc = document.getElementById('flashcard');
  fc.style.display = '';     // 清除 closeFcAll/showFcResult 遗留的内联 display:none
  fc.classList.add('open');
  document.getElementById('fc-title').textContent = `生词本背诵 · ${fcTotal}词`;
  showFcCard(true);
}

async function showFcCard(instant){
  if(fcIdx >= fcDeck.length){ showFcResult(); return; }
  const v = fcDeck[fcIdx];
  fcFlipped = false;

  const card    = document.getElementById('fc-card');
  const ratings = document.getElementById('fc-ratings');

  // Animate out (unless instant first card)
  // ✅ Only use opacity — never write style.transform here,
  //    so that .fc-card.flipped { transform: rotateY(180deg) } always wins
  if(!instant){
    card.style.transition = 'opacity .15s ease';
    card.style.opacity    = '0';
    card.style.transform  = '';   // clear any leftover swipe transform first
    await new Promise(r=>setTimeout(r,160));
  }

  // Reset flip & ratings
  card.style.transition = '';
  card.style.transform  = '';   // ensure CSS class is sole transform owner
  card.classList.remove('flipped','shake');
  ratings.classList.remove('show');
  document.getElementById('fc-fb-front').classList.remove('show');
  document.getElementById('fc-fb-back').classList.remove('show');

  // Fill front
  document.getElementById('fc-word').textContent     = v.word;
  document.getElementById('fc-ph-front').textContent = v.ph || '';
  document.getElementById('fc-badge-row').innerHTML  = '';

  // Star button
  const starBtn = document.getElementById('fc-star');
  starBtn.classList.toggle('starred', S.vocab.some(x=>x.word===v.word));

  // Fill back
  document.getElementById('fc-back-word-txt').textContent = v.word;
  document.getElementById('fc-meaning').textContent = v.meaning || '—';
  document.getElementById('fc-ph-back').textContent  = v.ph || '';
  document.getElementById('fc-en-def').textContent   = '';
  document.getElementById('fc-sent').textContent     = v.sent ? v.sent.trim().slice(0,150) : '';

  // Progress
  const pct = fcOrigTotal ? (fcDoneCount/fcOrigTotal)*100 : 0;
  document.getElementById('fc-prog-fill').style.width = pct+'%';
  document.getElementById('fc-count').textContent = fcDoneCount+'/'+fcOrigTotal;

  // 动态更新评分按钮的时间标签
  const _prevIv = fcMode==='deck'
    ? (vpProgress[v.word]?.interval || 0)
    : (fcSRS[v.word]?.interval || 0);
  document.querySelector('#fc-again .fc-rbtn-time').textContent = fmtInterval(SRS_INTERVALS.again);
  document.querySelector('#fc-hard .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('hard', _prevIv));
  document.querySelector('#fc-good .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('good', _prevIv));
  document.querySelector('#fc-easy .fc-rbtn-time').textContent  = fmtInterval(calcNextInterval('easy', _prevIv));

  // Fade in — opacity only; transform is 100% owned by CSS class
  card.style.transition = 'opacity .22s ease';
  card.style.opacity    = '1';

  // Fetch dictionary data (async, fills audio/enDef; won't override bundled phonetic if v.ph exists)
  fetchFcWord(v.word, !!v.ph);
}

async function fetchFcWord(word, skipPh=false){
  if(FC_CACHE.has(word)){
    applyFcCache(word, FC_CACHE.get(word), skipPh); return;
  }
  try{
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if(!r.ok) throw new Error('dict ' + r.status);
    const e = (await r.json())[0];
    const ph    = e.phonetics?.find(p=>p.text)?.text||'';
    const audio = e.phonetics?.find(p=>p.audio?.length>0)?.audio||'';
    const pos   = e.meanings?.[0]?.partOfSpeech||'';
    const enDef = e.meanings?.[0]?.definitions?.[0]?.definition||'';
    const data  = {ph,audio,pos,enDef};
    FC_CACHE.set(word, data);
    applyFcCache(word, data, skipPh);
  }catch(e){}
}

function applyFcCache(word, data, skipPh=false){
  // Only apply if still showing same word
  if(document.getElementById('fc-word').textContent !== word) return;
  if(data.ph && !skipPh){
    document.getElementById('fc-ph-front').textContent = data.ph;
    document.getElementById('fc-ph-back').textContent  = data.ph;
  }
  if(data.pos){
    const badge = document.createElement('span');
    badge.className = 'fc-badge fc-badge-pos';
    badge.textContent = data.pos;
    document.getElementById('fc-badge-row').appendChild(badge);
  }
  if(data.enDef)
    document.getElementById('fc-en-def').textContent = data.enDef;
}

function flipFcCard(){
  const card    = document.getElementById('fc-card');
  const ratings = document.getElementById('fc-ratings');
  fcFlipped = !fcFlipped;
  card.classList.toggle('flipped', fcFlipped);
  if(fcFlipped){
    // 翻到背面：280ms 后显示评级按钮
    setTimeout(()=> ratings.classList.add('show'), 280);
  } else {
    // 翻回正面：立刻隐藏评级按钮
    ratings.classList.remove('show');
  }
}

function rateFcCard(rating){
  if(!fcFlipped) return;
  const v   = fcDeck[fcIdx];
  const now = Date.now();

  // 动态间隔（基于上次间隔成倍增长）
  const prevInterval = fcMode==='deck'
    ? (vpProgress[v.word]?.interval || 0)
    : (fcSRS[v.word]?.interval || 0);
  const interval = calcNextInterval(rating, prevInterval);

  if(fcMode === 'deck'){
    const prev = vpProgress[v.word] || { correct:0, wrong:0, interval:0 };
    vpProgress[v.word] = {
      nextReview: now + interval,
      interval,
      correct: prev.correct + (rating !== 'again' ? 1 : 0),
      wrong:   prev.wrong   + (rating === 'again' ? 1 : 0)
    };
    saveVpProgress(vpDeck);
    pushVpWord(vpDeck, v.word);
  } else {
    fcSRS[v.word] = { nextReview: now + interval, interval, lastRating: rating };
    saveSRS();
  }
  fcCounts[rating]++;

  // Again：把卡片重新插入本轮靠后的位置（2~4 张之后）
  if(rating === 'again'){
    const offset = 2 + Math.floor(Math.random() * 3);
    const reinsert = Math.min(fcIdx + 1 + offset, fcDeck.length);
    fcDeck.splice(reinsert, 0, {...v});
  } else {
    fcDoneCount++;
  }

  // Feedback animation
  const isBad = rating === 'again' || rating === 'hard';
  const scene = document.getElementById('fc-card').closest('.fc-scene');
  if(isBad){
    // Shake the scene wrapper — never touch card's own transform
    scene.classList.add('shake');
    scene.addEventListener('animationend', ()=> scene.classList.remove('shake'), {once:true});
    const fb = document.getElementById('fc-fb-back');
    fb.textContent = '✗'; fb.style.background = 'rgba(220,38,38,.12)';
    fb.classList.add('show');
  } else {
    const fb = document.getElementById('fc-fb-back');
    fb.textContent = rating==='easy'?'★':'✓';
    fb.style.background = rating==='easy'?'rgba(37,99,235,.1)':'rgba(5,150,105,.1)';
    fb.classList.add('show');
  }

  setTimeout(()=> { fcIdx++; showFcCard(false); }, isBad ? 420 : 340);
}

function showFcResult(){
  document.getElementById('flashcard').classList.remove('open');
  document.getElementById('flashcard').style.display = 'none';
  const res = document.getElementById('fc-result');
  res.style.display = 'flex'; res.classList.add('open');

  const total = fcCounts.again+fcCounts.hard+fcCounts.good+fcCounts.easy;
  const known = fcCounts.good+fcCounts.easy;
  const pct   = total ? Math.round(known/total*100) : 0;

  const emoji = pct>=80?'🎉':pct>=50?'💪':'📚';
  document.getElementById('fc-res-emoji').textContent = emoji;
  document.getElementById('fc-res-sub').textContent   = `掌握率 ${pct}%`;
  document.getElementById('fc-res-stats').innerHTML = `
    <div class="fc-stat" style="background:#FEE2E2">
      <div class="fc-stat-n" style="color:#DC2626">${fcCounts.again}</div>
      <div class="fc-stat-l" style="color:#DC2626">Again</div>
    </div>
    <div class="fc-stat" style="background:#FEF3C7">
      <div class="fc-stat-n" style="color:#D97706">${fcCounts.hard}</div>
      <div class="fc-stat-l" style="color:#D97706">Hard</div>
    </div>
    <div class="fc-stat" style="background:#D1FAE5">
      <div class="fc-stat-n" style="color:#059669">${fcCounts.good}</div>
      <div class="fc-stat-l" style="color:#059669">Good</div>
    </div>
    <div class="fc-stat" style="background:#DBEAFE">
      <div class="fc-stat-n" style="color:#2563EB">${fcCounts.easy}</div>
      <div class="fc-stat-l" style="color:#2563EB">Easy</div>
    </div>`;
}

function closeFcAll(){
  document.getElementById('flashcard').classList.remove('open');
  document.getElementById('flashcard').style.display = 'none';
  document.getElementById('fc-result').classList.remove('open');
  document.getElementById('fc-result').style.display = 'none';
  if(fcMode === 'deck') openVocabPanel();
}

// ── Card swipe gesture
(()=>{
  const card   = document.getElementById('fc-card');
  let sx=0, sy=0, dx=0, moving=false;

  card.addEventListener('touchstart', e=>{
    sx=e.touches[0].clientX; sy=e.touches[0].clientY;
    dx=0; moving=false;
    card.style.transition='none';
  },{passive:true});

  card.addEventListener('touchmove', e=>{
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)<Math.abs(dy) && !moving) return; // vertical scroll
    moving=true;
    const rot=dx*0.04;
    card.style.transform=`translateX(${dx}px) rotate(${rot}deg)`;
  },{passive:true});

  card.addEventListener('touchend', (e)=>{
    if(!moving){
      // Tapped a button inside the card → don't flip
      if(e.target.closest('button')) return;
      card.style.transition='';
      card.style.transform='';
      flipFcCard(); return;
    }
    if(Math.abs(dx)>100 && fcFlipped){
      // Swipe off screen — animate the scene wrapper sideways, not the card itself
      const dir = dx>0?1:-1;
      const scn = card.closest('.fc-scene');
      scn.style.transition = 'transform .25s ease, opacity .25s ease';
      scn.style.transform  = `translateX(${dir*110}%)`;
      scn.style.opacity    = '0';
      const rating = dx>0?'good':'again';
      setTimeout(()=>{
        // reset scene position silently before next card renders
        scn.style.transition='none';
        scn.style.transform='';
        scn.style.opacity='1';
        // rateFcCard 需要 fcFlipped=true 才能执行，showFcCard 会自动重置
        rateFcCard(rating);
      }, 270);
    } else {
      // Snap back — restore position, then clear inline so CSS class controls it
      card.style.transition='transform .35s cubic-bezier(.34,1.4,.64,1), opacity .2s';
      card.style.transform = fcFlipped ? 'rotateY(180deg)' : '';
      card.style.opacity='1';
      setTimeout(()=>{
        card.style.transition = '';
        card.style.transform  = ''; // hand full control back to .fc-card.flipped
      }, 380);
    }
  },{passive:true});

  // Desktop click to flip
  card.addEventListener('click', (e)=>{
    if(e.target.closest('button')) return; // 点播放/收藏按钮不翻转
    if(window.matchMedia('(pointer:fine)').matches) flipFcCard();
  });
})();

// ── Button listeners
document.getElementById('voc-flash-btn').addEventListener('click', openFlashcard);
document.getElementById('fc-exit').addEventListener('click', closeFcAll);
document.getElementById('fc-again').addEventListener('click', ()=>rateFcCard('again'));
document.getElementById('fc-hard') .addEventListener('click', ()=>rateFcCard('hard'));
document.getElementById('fc-good') .addEventListener('click', ()=>rateFcCard('good'));
document.getElementById('fc-easy') .addEventListener('click', ()=>rateFcCard('easy'));

document.getElementById('fc-spk').addEventListener('click', e=>{
  e.stopPropagation();
  const w=document.getElementById('fc-word').textContent;
  const d=FC_CACHE.get(w);
  if(d?.audio) new Audio(d.audio).play().catch(()=>speakWord(w));
  else speakWord(w);
});
document.getElementById('fc-spk-back').addEventListener('click', e=>{
  e.stopPropagation();
  const w=document.getElementById('fc-word').textContent;
  const d=FC_CACHE.get(w);
  if(d?.audio) new Audio(d.audio).play().catch(()=>speakWord(w));
  else speakWord(w);
});
document.getElementById('fc-star').addEventListener('click', e=>{
  e.stopPropagation();
  const v=fcDeck[fcIdx];
  if(!v) return;
  const inV=S.vocab.some(x=>x.word===v.word);
  if(inV){ S.vocab.splice(S.vocab.findIndex(x=>x.word===v.word),1); }
  else   { addVocab(v.word, v.meaning||''); }
  e.currentTarget.classList.toggle('starred',!inV);
});

document.getElementById('fc-res-again').addEventListener('click', ()=>{
  document.getElementById('fc-result').classList.remove('open');
  document.getElementById('fc-result').style.display='none';
  if(fcMode === 'deck') startDeckSession();
  else openFlashcard();
});
document.getElementById('fc-res-back').addEventListener('click', ()=>{
  closeFcAll();
  if(fcMode !== 'deck'){
    document.getElementById('voc').classList.add('open');
    document.getElementById('overlay').classList.add('vis');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', e=>{
  if(!document.getElementById('flashcard').classList.contains('open')) return;
  if(e.code==='Space'||e.code==='ArrowUp'){ e.preventDefault(); flipFcCard(); }
  if(e.key==='1') rateFcCard('again');
  if(e.key==='2') rateFcCard('hard');
  if(e.key==='3') rateFcCard('good');
  if(e.key==='4') rateFcCard('easy');
  if(e.key==='Escape') closeFcAll();
});


// ═══════════════════════════════════════════
//  VOCAB DECK PANEL
// ═══════════════════════════════════════════
function openVocabPanel(){
  loadVpProgress(vpDeck);
  updateVpStats();
  document.getElementById('vocab-panel').style.display = 'block';
  document.getElementById('landing').style.display = 'none';
  document.getElementById('library').classList.remove('open');
  closeSidebar();
}

function closeVocabPanel(){
  document.getElementById('vocab-panel').style.display = 'none';
  document.getElementById('landing').style.display = '';
}

function getDeckWordList(deck){
  if(deck === 'cet4')  return typeof CET4     !== 'undefined' ? CET4     : [];
  if(deck === 'ogden') return typeof OGDEN850 !== 'undefined' ? OGDEN850 : [];
  return [];
}

function updateVpStats(){
  const now = Date.now();
  ['cet4','ogden'].forEach(deck => {
    const wordList = getDeckWordList(deck);
    const total    = wordList.length;
    const prog = deck === vpDeck ? vpProgress : (() => {
      try{ return JSON.parse(localStorage.getItem('vp_'+deck)||'{}'); }catch(e){ return {}; }
    })();
    const newCount      = wordList.filter(w => !prog[w.w]).length;
    const dueCount      = wordList.filter(w => prog[w.w] && prog[w.w].nextReview <= now).length;
    const masteredCount = wordList.filter(w => prog[w.w] && prog[w.w].correct >= 3).length;
    const pct = total > 0 ? Math.round(masteredCount / total * 100) : 0;
    const elId = deck === 'cet4' ? 'cet4-progress' : 'ogden-progress';
    const el = document.getElementById(elId);
    if(el) el.innerHTML =
      `新词 ${newCount} · 待复习 ${dueCount}<br>` +
      `<span style="color:var(--green-2,#16A34A);font-weight:700">已掌握 ${masteredCount}/${total}（${pct}%）</span>`;
  });
}

function startDeckSession(){
  const wordList = getDeckWordList(vpDeck);
  if(!wordList.length){ toast('词库加载失败'); return; }
  const now = Date.now();
  const due  = wordList.filter(w => vpProgress[w.w] && vpProgress[w.w].nextReview <= now);
  const newW = wordList.filter(w => !vpProgress[w.w]);
  const shuffle = arr => [...arr].sort(()=>Math.random()-.5);
  const pool = [...shuffle(due), ...shuffle(newW)];

  fcDeck  = pool.slice(0, vpCount).map(w => ({ word:w.w, ph:w.ph, meaning:w.cn }));
  fcIdx   = 0; fcFlipped = false;
  fcCounts = {again:0,hard:0,good:0,easy:0};
  fcTotal     = fcDeck.length;
  fcOrigTotal = fcDeck.length;
  fcDoneCount = 0;
  fcMode  = 'deck';

  if(!fcDeck.length){ toast('今日没有待复习单词，明天再来！'); return; }

  document.getElementById('vocab-panel').style.display = 'none';
  const fc = document.getElementById('flashcard');
  fc.style.display = '';
  fc.classList.add('open');
  const deckLabel = vpDeck === 'ogden' ? 'Ogden 850' : vpDeck.toUpperCase();
  document.getElementById('fc-title').textContent = `${deckLabel} · ${fcTotal} 词`;
  document.getElementById('fc-res-back').textContent = '返回词库';
  showFcCard(true);
}

// ── Vocab panel event listeners
document.getElementById('deck-open-btn').addEventListener('click', openVocabPanel);
document.getElementById('vp-close').addEventListener('click', closeVocabPanel);
document.getElementById('vp-start').addEventListener('click', startDeckSession);

// Deck selector
document.querySelectorAll('.vp-deck').forEach(el=>{
  el.addEventListener('click', ()=>{
    document.querySelectorAll('.vp-deck').forEach(d=>d.classList.remove('on'));
    el.classList.add('on');
    vpDeck = el.dataset.deck;
    loadVpProgress(vpDeck);
    updateVpStats();
  });
});

// Session count selector
document.querySelectorAll('.vp-nb').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.vp-nb').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on');
    vpCount = parseInt(btn.dataset.n, 10);
  });
});

// Sync from Supabase on login
window._syncVpProgress = async function(){
  await syncVpFromSupabase(vpDeck);
  if(document.getElementById('vocab-panel').style.display !== 'none') updateVpStats();
};

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
  if(e.code==='ArrowRight') document.getElementById('next-btn').click();
  if(e.code==='ArrowLeft') document.getElementById('prev-btn').click();
  if(e.key==='Escape'){
    wpop.classList.remove('vis');
    document.getElementById('library').classList.remove('open');

    closeSidebar();
    closeVoc();
  }
});

// ═══════════════════════════════════════════
//  SUPABASE — 轻量客户端（无 SDK，纯 fetch）
// ═══════════════════════════════════════════
const SB = (() => {
  const BASE = 'https://ueskojxtupmxwolzxdxa.supabase.co';
  const KEY  = 'sb_publishable_-hbkl0aTVPGCfSL8rk6WPQ_mzGQ52O-';
  let tok = null;

  function h(extra = {}) {
    return {
      'apikey': KEY,
      'Content-Type': 'application/json',
      ...(tok ? { 'Authorization': 'Bearer ' + tok } : {}),
      ...extra
    };
  }

  async function req(path, opts = {}) {
    const extra = opts.headers || {};
    delete opts.headers;
    const r = await fetch(BASE + path, { ...opts, headers: h(extra) });
    const text = await r.text();
    const d = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(d.error_description || d.message || d.msg || '请求失败 ' + r.status);
    return d;
  }

  return {
    get accessToken(){ return tok; },

    async signIn(email, password) {
      const d = await req('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      tok = d.access_token;
      localStorage.setItem('sb_tok', tok);
      localStorage.setItem('sb_ref', d.refresh_token || '');
      return d.user;
    },

    async signUp(email, password) {
      const d = await req('/auth/v1/signup', {
        method: 'POST', body: JSON.stringify({ email, password })
      });
      if (d.access_token) {
        tok = d.access_token;
        localStorage.setItem('sb_tok', tok);
        localStorage.setItem('sb_ref', d.refresh_token || '');
      }
      return d.user || d;
    },

    async signOut() {
      try { await req('/auth/v1/logout', { method: 'POST' }); } catch(e) {}
      tok = null;
      localStorage.removeItem('sb_tok');
      localStorage.removeItem('sb_ref');
    },

    async restoreSession() {
      const saved = localStorage.getItem('sb_tok');
      if (!saved) return null;
      try {
        tok = saved;
        return await req('/auth/v1/user');
      } catch(e) {
        // 尝试 refresh token
        const ref = localStorage.getItem('sb_ref');
        if (!ref) { tok = null; localStorage.removeItem('sb_tok'); return null; }
        try {
          const d = await req('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST', body: JSON.stringify({ refresh_token: ref })
          });
          tok = d.access_token;
          localStorage.setItem('sb_tok', tok);
          localStorage.setItem('sb_ref', d.refresh_token || '');
          return d.user;
        } catch(e2) {
          tok = null;
          localStorage.removeItem('sb_tok'); localStorage.removeItem('sb_ref');
          return null;
        }
      }
    },

    async selectVocab(userId) {
      return req(`/rest/v1/vocab?user_id=eq.${userId}&order=time.asc&select=word,meaning,sent,time`);
    },

    async upsertVocab(rows) {
      return req('/rest/v1/vocab', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
    },

    async deleteVocab(userId, word) {
      return req(`/rest/v1/vocab?user_id=eq.${userId}&word=eq.${encodeURIComponent(word)}`, {
        method: 'DELETE'
      });
    },

    async rpc(fn) {
      return req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: '{}' });
    },

    async selectUserBooks(userId) {
      return req(`/rest/v1/user_books?user_id=eq.${userId}&order=added_at.asc&select=id,title,author,year,url,mark,isbn,pal,cat`);
    },

    async insertUserBook(row) {
      return req('/rest/v1/user_books', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(row)
      });
    },

    async deleteUserBook(id) {
      return req(`/rest/v1/user_books?id=eq.${id}`, { method: 'DELETE' });
    },

    async selectVocabProgress(userId, deck) {
      return req(`/rest/v1/vocab_progress?user_id=eq.${userId}&deck=eq.${deck}&select=word,next_review,correct_count,wrong_count`);
    },

    async upsertVocabProgress(userId, deck, word, data) {
      return req('/rest/v1/vocab_progress', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: userId,
          deck,
          word,
          status: data.correct > 3 ? 'known' : 'learning',
          next_review: new Date(data.nextReview).toISOString(),
          correct_count: data.correct,
          wrong_count: data.wrong,
          last_seen: new Date().toISOString()
        }])
      });
    }
  };
})();

let currentUser = null;

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
  results.forEach(book => {
    const isBuiltin = !!book._builtin;
    const isAdded   = userBooks.some(b => b.url === book.url);
    const disabled  = isBuiltin || isAdded;
    const btnText   = isBuiltin ? '已内置' : isAdded ? '已添加' : '+ 添加';
    const catTags   = (book.cat||[]).map(c =>
      `<span class="gb-cat">${CAT_LABELS[c]||c}</span>`).join('');
    const el = document.createElement('div');
    el.className = 'gb-item';
    el.innerHTML = `
      <div class="gb-item-info">
        <div class="gb-item-title">${book.t}</div>
        <div class="gb-item-meta">${book.a}${book.y ? ' · ' + book.y : ''}</div>
        <div class="gb-cats">${catTags}</div>
      </div>
      <button class="gb-add-btn"${disabled?' disabled':''}>${btnText}</button>`;
    if(!disabled){
      el.querySelector('.gb-add-btn').addEventListener('click', async function(){
        this.disabled = true; this.textContent = '添加中…';
        const ok = await addUserBook(book);
        this.textContent = ok ? '已添加' : '失败';
      });
    }
    res.appendChild(el);
  });
}

// ── 搜索面板事件
const gbPanel  = document.getElementById('gb-panel');
const gbAddBtn = document.getElementById('lib-add-btn');
const gbInput  = document.getElementById('gb-input');
const gbSearch = document.getElementById('gb-search-btn');

let gbTimer;
function triggerSearch(){
  clearTimeout(gbTimer);
  const q = gbInput.value.trim();
  if(!q){ document.getElementById('gb-results').innerHTML = ''; return; }
  gbTimer = setTimeout(() => renderSearchResults(localSearch(q)), 120);
}

gbAddBtn.addEventListener('click', () => {
  const open = gbPanel.style.display === 'none';
  gbPanel.style.display = open ? '' : 'none';
  gbAddBtn.classList.toggle('active', open);
  if(open){ gbInput.focus(); triggerSearch(); }
});
gbInput.addEventListener('input', triggerSearch);
gbSearch.addEventListener('click', triggerSearch);
gbInput.addEventListener('keydown', e => { if(e.key==='Enter') triggerSearch(); });

// ── UI helpers
function setAuthUI(user){
  currentUser = user;
  const loginBtn = document.getElementById('login-btn');
  const userBtn  = document.getElementById('user-btn');
  if(user){
    loginBtn.style.display = 'none';
    userBtn.style.display  = '';
    // Show initials
    const initials = (user.email||'?')[0].toUpperCase();
    userBtn.textContent = initials;
    document.getElementById('um-email').textContent = user.email;
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

// ── User menu
const userBtn  = document.getElementById('user-btn');
const userMenu = document.getElementById('user-menu');
userBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = userMenu.classList.toggle('open');
  if(open){
    const rect = userBtn.getBoundingClientRect();
    userMenu.style.top   = (rect.bottom + 6) + 'px';
    userMenu.style.right = (window.innerWidth - rect.right) + 'px';
  }
});
document.addEventListener('click', () => userMenu.classList.remove('open'));
userMenu.addEventListener('click', e => e.stopPropagation());

document.getElementById('um-sync').addEventListener('click', async ()=>{
  userMenu.classList.remove('open');
  toast('同步中…');
  await syncVocab();
});
document.getElementById('um-logout').addEventListener('click', async ()=>{
  await SB.signOut();
  setAuthUI(null);
  userMenu.classList.remove('open');
  toast('已退出登录');
  userBooks = [];
  renderUserBooks();
});

// ── 页面加载时恢复 session + 记录访问
(async () => {
  try {
    const user = await SB.restoreSession();
    if(user) setAuthUI(user);
  } catch(e) { console.warn('session restore:', e.message); }
  await loadUserBooks();
  SB.rpc('record_visit').catch(()=>{});
})();

// ── 全局兜底：防止任何 unhandled rejection 显示为 "Script error."
window.addEventListener('unhandledrejection', e => {
  console.warn('Unhandled rejection:', e.reason);
  e.preventDefault();
});

// ── INIT
const sv=localStorage.getItem('vocab');
if(sv) S.vocab=JSON.parse(sv);

// ── PWA: register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/Linggo/sw.js', { scope: '/Linggo/' })
      .catch(() => {});
  });
}
