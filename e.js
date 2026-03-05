const res = await fetch("http://localhost:3333/scrape", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://www.ycombinator.com/companies/martini" })
});

const data = await res.json();
console.log(data.text);
console.log(`ms: ${data.ms}`);