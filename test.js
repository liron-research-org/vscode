const el = element.innerHTML;

function bad1(userInput) {
// ruleid: insecure-document-method
  el.innerHTML = '<div>' + userInput + '</div>';
}

function bad2(userInput) {
// ruleid: insecure-document-method
  document.body.outerHTML = userInput;
}

function bad3(userInput) {
  const name = '<div>' + userInput + '</div>'; 
// ruleid: insecure-document-method
  document.write(name);
}

function ok1() {
  const name = "<div>it's ok</div>";
// ok: insecure-document-method
  el.innerHTML = name;
}

function ok2() {
// ok: insecure-document-method
  document.write("<div>it's ok</div>");
}


// ruleid:dom-based-xss
document.write("<OPTION value=1>"+document.location.href.substring(document.location.href.indexOf("default=")+8)+"</OPTION>");

// ok:dom-based-xss
document.write("<OPTION value=2>English</OPTION>");

async function okTest() {
  const p = Deno.run({
    cmd: ["echo", "hello"],
  });

  await p.status();
}

async function test1(userInput) {
// ruleid: deno-dangerous-run
  const p = Deno.run({
    cmd: [userInput, "hello"],
    stdout: "piped",
    stderr: "piped",
  });

  await p.status();
}

async function test1(userInput) {
// ruleid: deno-dangerous-run
  const p = Deno.run({
    cmd: ["bash", "-c", userInput],
    stdout: "piped",
    stderr: "piped",
  });

  await p.status();
}
