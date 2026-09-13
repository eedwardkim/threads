import type { DemoConversation } from "./demo-catalog";
import { md, pythonWorkbook } from "./demo-format";

const { examples: pythonExamples, py } = pythonWorkbook();
export { pythonExamples };
const sources = [
  "CS61A Fall 2026 schedule, checked 13 September 2026: https://cs61a.org/fa26/",
  "Official CS61A Midterm 1 study guide: https://site.cs61a.org/assets/pdfs/61a-mt1-study-guide.pdf",
  "Fall 2026 Environments lecture: https://cs61a.org/fa26/assets/lec/05-Environments.pdf",
  "Fall 2026 Function Examples / Midterm 1 Review: https://cs61a.org/fa26/assets/lec/07-Midterm_1_Review_Part_1.pdf",
];

export const conversations: DemoConversation[] = [
  {
    id: "demo-cs-closures",
    goal: "Trace functions returned by nested definitions, retain defining frames, and distinguish captured bindings from frozen values.",
    sources,
    exchanges: [
      {
        user: "I understand global functions now. How can a returned function still use n after make_adder has finished?",
        assistant: md`## Returning does not erase a referenced defining environment

${py("independent-adder-closures", `def make_adder(n):
    def adder(k):
        return n + k
    return adder

add_three = make_adder(3)
add_ten = make_adder(10)
print(add_three(4), add_ten(4))`, "7 14\n")}

Each call to \`make_adder\` creates its own local frame. Executing the nested def creates a new function whose parent is that particular frame. The two returned functions therefore have different defining parents, even though their bodies have the same source text.

When \`add_three(4)\` runs, its call frame contains \`k = 4\` and has the earlier \`make_adder(3)\` frame as parent. Lookup finds \`n = 3\` there.

A closure is a function together with access to the lexical environment it needs. The environment-diagram model retains the parent frame; Python's implementation can retain the required bindings without literally preserving every implementation detail of a diagram box.

Do not cross out a defining frame merely because its call returned if a returned function still refers to it.`,
        summary: "Each factory call creates a separate defining environment and returned function; closure lookup follows the retained lexical parent, not the later caller.",
        threads: [{
          quote: "different defining parents", title: "Same code does not imply the same closure", resolved: true,
          exchanges: [
            { user: "Are add_three and add_ten really two different function values, or one function with a changing n?", assistant: md`They are different function values created by two executions of the nested def. Each is associated with a different call's binding of \`n\`. Calling \`make_adder(10)\` does not overwrite the \`n\` retained by the earlier closure from \`make_adder(3)\`.` },
            { user: "So I need two function objects and two parent arrows in the diagram.", assistant: md`Exactly. Both may have the intrinsic name \`adder\`, but their parent annotations distinguish them. The global names \`add_three\` and \`add_ten\` point to those separate function values. Identical body text is not enough to merge them.` },
          ],
        }],
      },
      {
        user: "Does the closure freeze n when the def runs, or look up n when I later call the returned function?",
        assistant: md`## Capture access to a binding, not a snapshot of its old value

${py("closure-sees-rebinding", `def factory():
    n = 2
    def read_plus(x):
        return n + x
    n = 5
    return read_plus

f = factory()
print(f(10))`, "15\n")}

The function's parent is chosen at definition time, but the value found through that environment is used when its body executes. The assignment \`n = 5\` updates the binding in the same defining frame before the returned function is called.

Do not confuse two separate facts: lexical scope fixes **which environment** lookup follows; it does not generally freeze **every value** in that environment at the instant a function is created.

This example does not require mutation of a list or a special nonlocal assignment inside the inner function. It uses ordinary rebinding in the outer frame while that outer call is still executing.

When tracing a closure, save the parent reference, then read the bindings as they stand when the body runs.`,
        summary: "Lexical capture retains access to a binding; later outer-frame rebinding before invocation can change the value read without changing the closure's parent.",
        threads: [{
          quote: "the value found through that environment", title: "What if the inner parameter has the same name?", resolved: true,
          exchanges: [
            { user: "If the returned lambda also has a parameter called n, does it add both n values somehow?", assistant: md`No. A local parameter binding is found before an enclosing binding with the same name. For \`def outer(n): return lambda n: n + 1\`, the expression \`outer(100)(2)\` returns 3. The lambda body's \`n\` refers to its own argument 2; it does not also refer to the outer 100.` },
            { user: "Then parent frames matter only after lookup doesn't find an applicable local binding.", assistant: md`Correct for the ordinary lookup cases being traced here. First identify the name's scope and local binding, then follow the lexical chain as needed. Repeated spelling is not a request to combine values from several frames.` },
          ],
        }],
      },
      {
        user: "Can we contrast reading a global variable with passing that value into a factory? This seems like where late binding becomes confusing.",
        assistant: md`## Same initial number, different lookup paths

${py("global-versus-local-capture", `n = 1

def global_reader():
    return lambda: n

def local_reader(n):
    return lambda: n

g = global_reader()
h = local_reader(n)
n = 8
print(g(), h())`, "8 1\n")}

The closure returned by \`global_reader\` has no enclosing local binding for \`n\`, so lookup reaches the global binding, now 8. The closure returned by \`local_reader\` finds the parameter \`n = 1\` in its defining call frame.

Passing an argument evaluated the global \`n\` at that earlier call site and bound its value to a different local name. It did not create a live alias from the local parameter back to the global variable.

This is why “closures always remember the original value” and “closures always use the latest global value” are both bad slogans. The actual parent chain and bindings decide the answer.

Draw the two environments explicitly; the numerical coincidence at creation time is less important than where each name will be found.`,
        summary: "A closure may read a changing global or a distinct captured parameter; the lexical binding path, not a slogan about old/new values, determines behavior.",
        threads: [{
          quote: "both bad slogans", title: "Separate closure behavior from later mutation topics", resolved: false,
          exchanges: [
            { user: "Should I memorize the list-of-lambdas loop trick too? People keep sending me that example.", assistant: md`It is a useful later extension, but do not let it replace the simpler rule. Multiple closures can share access to one binding, so what they return depends on the value that binding has when called. For your present review, first master one factory call, two independent factory calls, and an outer rebinding. Those diagrams explain the underlying mechanism.` },
            { user: "I'll leave that extension open and make sure I can derive these three cases cold.", assistant: md`Good. A compact self-test is to change a global binding, then change an outer local binding, then shadow the name with an inner parameter. Predict which changes each closure observes and justify each answer by lookup. That is more transferable than memorizing a tricky output without understanding its environment.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-lambda",
    goal: "Read lambda expressions as function creation, parse curried call chains, and distinguish expression bodies from statements.",
    sources,
    exchanges: [
      {
        user: "Lambdas look like a different language. Can we connect them to def without hand-waving away the parentheses?",
        assistant: md`## A lambda expression produces a function value

A lambda specifies parameters and a single expression body. Its body is evaluated when the resulting function is called, not when the lambda expression creates it. It has a lexical parent just like a function created by def.

${py("lambda-creation-and-calls", `f = lambda x: x + 1
g = lambda: f

print(f(4))
print(g()(4))
print((lambda x: lambda y: x + y)(2)(3))`, "5\n5\n5\n")}

The zero-argument \`g\` returns the function currently found through the name \`f\`. Therefore \`g()(4)\` first calls \`g\`, then applies its returned function to 4.

In the last expression, the outer lambda is applied to 2, producing an inner function whose parent contains \`x = 2\`. The next call binds \`y = 3\` and adds them.

A lambda does not use a return keyword: the value of its body expression is its return value. This restriction is syntactic, not a different scope model.`,
        summary: "Lambda creates an ordinary lexically scoped function with a single expression body; nested applications create separate frames and may return further functions.",
        threads: [{
          quote: "Its body is evaluated when", title: "Can a lambda contain a print call?", resolved: true,
          exchanges: [
            { user: "I thought lambdas can't print because they're only expressions.", assistant: md`A call expression such as \`print(x)\` is allowed as a lambda body. Calling \`lambda x: print(x)\` prints the argument and returns None. What you cannot put there is an ordinary multi-statement suite with assignments and return statements as you would under def.` },
            { user: "Then 'single expression' doesn't mean 'no side effects'.", assistant: md`Exactly. Expressions can call effectful functions. Purity and syntax are different concepts. The same distinction explains why creating a lambda is usually quiet while invoking it can print, raise an exception, or call other functions.` },
          ],
        }],
      },
      {
        user: "What's currying actually changing? How is add(3, 4) different from curried_add(3)(4)?",
        assistant: md`## Change the calling interface, not the arithmetic

${py("currying-and-uncurrying", `from operator import add, mul

def curry2(f):
    return lambda x: lambda y: f(x, y)

def uncurry2(g):
    return lambda x, y: g(x)(y)

curried_add = curry2(add)
print(curried_add(3)(4))
print(uncurry2(curry2(mul))(6, 7))`, "7\n42\n")}

A binary function accepts two arguments in one application. Its curried form accepts the first argument and returns a function waiting for the second. Supplying just the first argument is now a complete, valid application that produces a callable.

The inner function retains access to both the original function parameter and the first supplied argument through its lexical parent chain.

Do not call the curried version with two arguments at once unless its signature actually accepts two. Currying changes arity at each stage; it does not make Python automatically collect any grouping of arguments you happen to write.

This is useful when another higher-order function expects a one-argument function and you want to specialize a multi-argument operation.`,
        summary: "Currying turns a binary application into two unary applications with captured state; uncurry2 reconstructs the binary interface.",
        threads: [{
          quote: "Currying changes arity at each stage", title: "Which frame remembers the original function?", resolved: false,
          exchanges: [
            { user: "In curry2(add)(3)(4), where does the final lambda find f?", assistant: md`The \`curry2\` call frame binds \`f\` to the add function. The outer lambda's call frame binds \`x = 3\` and has the curry2 frame as parent. The inner lambda's call frame binds \`y = 4\` and has the x-frame as parent. Lookup for f walks through that chain to the original curry2 frame.` },
            { user: "I need to draw all three frames instead of trying to cram f, x, and y into one.", assistant: md`Yes. The final result uses all three bindings, but they were introduced by different applications. Draw the parent of each newly created function when its lambda expression executes; then each later call frame inherits that recorded parent. This is a good diagram to practice until you can explain every arrow.` },
          ],
        }],
      },
      {
        user: "Give me a lambda parsing question where the correct answer comes from following values rather than visually counting lambdas.",
        assistant: md`## Name intermediate values when the syntax gets dense

${py("lambda-function-as-result", `a = lambda x: x + 1
b = (lambda x: x)(lambda x: x + 1)

print(a(2), b(2))
print((lambda f: f(3))(lambda x: x * x))`, "3 3\n9\n")}

The identity lambda in the assignment to \`b\` receives a function value and returns that same value. It does not call the received function. Thus \`b\` refers to an increment function, which is applied only later.

In the final line, the outer lambda receives a square function and explicitly calls it on 3. That difference—returning \`f\` versus returning \`f(3)\`—is the whole point.

When stuck, rewrite only the intermediate values, not the semantics: “this subexpression produces an identity function; its argument is an increment function; the call returns that increment function.” Then continue.

Also use explicit parentheses around an immediately called lambda. Without them, an apparent call may be part of the lambda's body instead of an application of the lambda itself. Parse first, then evaluate.`,
        summary: "Returning a function value differs from applying it; break dense lambda syntax into intermediate values and preserve grouping before tracing calls.",
        threads: [{
          quote: "It does not call the received function.", title: "Why lambda x: x(3) is not lambda x: x", resolved: true,
          exchanges: [
            { user: "These two expressions look almost identical, but one needs x to be callable.", assistant: md`Exactly. \`lambda x: x\` can return any supplied value. \`lambda x: x(3)\` assumes its argument can be applied to 3. If you pass the integer 7, the identity function returns 7, while the second function raises TypeError when its body tries to call 7.` },
            { user: "So I should annotate whether each intermediate result is a number or a function.", assistant: md`That helps enormously. You do not need a full static type system to ask “what kind of value is this operator about to use?” A small value ledger catches attempts to call a number and accidental early application of a function that was meant to be returned.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-composition",
    goal: "Build reusable unary-function combinators, understand composition order, and construct repeated application without accidental capture bugs.",
    sources,
    exchanges: [
      {
        user: "Composition order keeps flipping in my head. If compose takes f and g, which one happens first?",
        assistant: md`## Read the body, not the English name

${py("composition-order", `def compose(f, g):
    return lambda x: f(g(x))

def increment(x):
    return x + 1

def square(x):
    return x * x

print(compose(square, increment)(3))
print(compose(increment, square)(3))`, "16\n10\n")}

For this definition, the returned function applies \`g\` first and then \`f\`. The first example increments 3 to 4 and squares to 16; the second squares to 9 and increments to 10.

Composition is generally not commutative. Swapping the two functions changes the result unless those particular functions commute on the relevant inputs.

The compose call does not apply either supplied function to a number yet. It builds a function that will do that when later called. Its closure remembers the two supplied function values through the compose call frame.

When analyzing another person's helper, inspect the body: a helper named compose could have been defined with the opposite argument convention.`,
        summary: "compose(f,g)(x)=f(g(x)) applies g first; construction is separate from invocation, and composition is generally noncommutative.",
        threads: [{
          quote: "does not apply either supplied function", title: "Constructing a composition versus executing it", resolved: true,
          exchanges: [
            { user: "If f and g print things, does compose(f, g) print those things immediately?", assistant: md`Not with this implementation. It creates a lambda and returns it. The body containing \`f(g(x))\` runs only when the returned function is applied. At that later time, g's effects occur before f's effects because g's return value is needed as f's argument.` },
            { user: "Then I can tell construction-time effects from call-time effects by where the print statement is placed.", assistant: md`Yes. A print in compose's own body would happen during construction. A print inside the returned function would happen on each later invocation. Trace which function body is currently executing rather than assuming all nested source code executes together.` },
          ],
        }],
      },
      {
        user: "Implement repeated application. The n = 0 case should make sense, and I don't want to use recursion before the midterm.",
        assistant: md`## Return a function that runs a loop when called

${py("repeat-iteratively", `def repeat(f, n):
    def apply(x):
        k = 0
        while k < n:
            x = f(x)
            k = k + 1
        return x
    return apply

increment = lambda x: x + 1
print(repeat(increment, 0)(10))
print(repeat(increment, 3)(10))`, "10\n13\n")}

Contract: n is a nonnegative integer and f accepts each value produced by its previous application. At the loop header, x is the original input after k applications of f.

For zero repetitions, no call to f occurs and the input is returned unchanged: the identity function's behavior. Constructing \`repeat(f, n)\` also does not call f; it returns the helper.

Each invocation of the returned helper creates a new local x and k. Calling it twice does not continue the previous call's counter.

The outer frame supplies the fixed f and n, while the inner call owns the changing loop state. That division of responsibilities is visible directly in an environment diagram.`,
        summary: "Iterative repeat returns a closure over f and n, uses fresh per-call loop state, and behaves as identity for n=0.",
        threads: [{
          quote: "no call to f occurs", title: "Identity is not the same as calling f once", resolved: true,
          exchanges: [
            { user: "I initialized the result as f(x), then looped n - 1 times. Why is zero awkward?", assistant: md`Because you already applied f before checking whether any applications were requested. That can produce the wrong value or an unwanted effect for n=0. Initializing the state to the original input and counting completed applications from zero matches the contract directly.` },
            { user: "The loop invariant tells me what the zero state has to be.", assistant: md`Exactly. “x is the input after k applications” with k=0 forces x to be the untouched input. That invariant makes the zero case ordinary instead of a patch. It also tells you when to stop: after exactly n completed applications.` },
          ],
        }],
      },
      {
        user: "Can we build the repeated function itself by composition? I tried result = lambda x: f(result(x)) and got a disaster.",
        assistant: md`## Preserve the previous function value in a new environment

${py("repeat-by-composition", `def compose(f, g):
    return lambda x: f(g(x))

def repeat(f, n):
    result = lambda x: x
    k = 0
    while k < n:
        result = compose(f, result)
        k = k + 1
    return result

print(repeat(lambda x: x * 2, 3)(5))
print(repeat(lambda x: x * 2, 0)(5))`, "40\n5\n")}

Each call to compose receives the **current function value** of result and binds it to a new local g. The returned lambda retains that particular binding, so the growing chain has well-defined links to earlier functions.

By contrast, a lambda body that refers directly to the outer variable result will look that name up later. If result has then been rebound to that same lambda, the body can call itself instead of the intended previous function.

This is a closure-binding bug, not a mathematical failure of composition. The construction above has no explicit recursive definition, although applying a long composition creates nested function calls. The iterative version is often easier to trace and avoids a deep call chain.`,
        summary: "Composition-based repetition captures the previous result as a distinct compose parameter; directly closing over a repeatedly rebound result can create unintended self-reference.",
        threads: [{
          quote: "look that name up later", title: "Why merely renaming result to old may not fix capture", resolved: false,
          exchanges: [
            { user: "Would assigning old = result each loop and then closing over old always fix it?", assistant: md`Not if every created lambda shares the same outer binding named old and that binding is reassigned in later iterations. They can all observe its later value. What the compose helper provides is a **new call frame and parameter binding per step**, not just another variable name in the same frame.` },
            { user: "So the fix is a fresh binding environment, not a nicer name.", assistant: md`Precisely. Draw two loop iterations and mark which frame owns each g. If both closures point to one repeatedly changed binding, you have not captured separate prior function values. Leave this as a diagram exercise: it connects aliases, closure lookup, and higher-order abstraction in one small example.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-debugging",
    goal: "Combine evaluation order, closures, and side effects, and distinguish NameError, UnboundLocalError, and noncallable TypeError without erasing earlier output.",
    sources,
    exchanges: [
      {
        user: "I want a mixed trace that forces me to distinguish constructing a closure from calling it, and to keep all the prints in order.",
        assistant: md`## Two clocks: factory time and returned-function time

${py("factory-and-call-effects", `def announce(x):
    print("a", x)
    return x + 1

def make(x):
    print("m", x)
    return lambda y: announce(x + y)

f = make(2)
print(f(3))
print(f(4))`, "m 2\na 5\n6\na 6\n7\n")}

The factory prints \`m 2\` once, when f is assigned. Creating the lambda does not run its body. Each later call creates a fresh y binding, combines it with the retained x=2, and calls announce.

The announce call prints before returning its incremented number. Only then does the outer print display that returned number.

Write an event log with the currently executing frame beside each print. If your trace contains two copies of \`m 2\`, you probably re-executed the factory in your head instead of invoking its returned function. If it lacks \`a 5\`, you probably skipped a side effect while replacing a call by its return value.`,
        summary: "Factory effects occur during construction; returned-function effects recur on invocation, with lexical x and fresh y bindings and ordered inner/outer prints.",
        threads: [{
          quote: "you probably re-executed the factory", title: "Does calling f rerun make?", resolved: true,
          exchanges: [
            { user: "I keep imagining the whole make body running each time because that is where the lambda came from.", assistant: md`Calling f applies the function value returned earlier, not the factory that created it. The factory's retained frame supplies bindings needed by the closure; retaining that frame does not mean re-executing its statements. The source location of a function and its call behavior are different things.` },
            { user: "So the parent arrow is a lookup link, not a command to rerun the parent.", assistant: md`Exactly. Parent links describe where names are resolved. They do not encode a sequence of statements to replay. This is one of the most useful distinctions to make explicit in an environment diagram.` },
          ],
        }],
      },
      {
        user: "I saw UnboundLocalError even though the same variable existed globally. Is that just Python being inconsistent with the lookup rule?",
        assistant: md`## A scope edge case, not a new global value

${py("unbound-local-before-assignment", `x = 10

def f():
    print(x)
    x = 20

f()`, "", "UnboundLocalError")}

Because the function body assigns to x, Python treats x as local throughout that body unless a relevant declaration changes its scope. At the first print, that local variable has not yet received a value, so lookup does not fall back to global x.

This is a useful edge case beyond simply following arrows for already-bound names. The function's local scope is determined from its code; it is not established only after execution reaches the assignment line.

A different example that merely reads x without assigning it would use the global binding normally. For clear beginner code, pass the required value as a parameter and return a new value rather than introducing global/nonlocal state just to silence the error.

No line is printed here: evaluating the print argument fails before the print function can be applied.`,
        summary: "Assignment makes x local throughout a function body; reading it before binding raises UnboundLocalError instead of falling back to global, before any print occurs.",
        threads: [{
          quote: "before the print function can be applied", title: "NameError versus UnboundLocalError versus None", resolved: true,
          exchanges: [
            { user: "I was treating an unbound local as if its value were None.", assistant: md`They are different states. A name bound to None has a real value and can be looked up successfully. An unbound local has no value available at that point, so reading it raises an exception. A missing name with no binding found in the relevant scopes can raise NameError. UnboundLocalError is a more specific subclass of NameError.` },
            { user: "Then I shouldn't draw a None arrow for every name that hasn't been assigned yet.", assistant: md`Correct. Draw only bindings that exist, following the course's diagram conventions. None appears when it is actually assigned or returned, not as an automatic default for uninitialized local variables. Distinguishing absence from a None value also helps with ordinary debugging.` },
          ],
        }],
      },
      {
        user: "If the operator isn't callable, do its argument expressions still run? And what if the operator name itself doesn't exist?",
        assistant: md`## Resolving an operator and applying it are different steps

${py("noncallable-after-argument-effects", `def reveal(x):
    print(x)
    return x

value = 7
value(reveal("argument"))`, "argument\n", "TypeError")}

The operator lookup succeeds and produces 7. Python then evaluates the operand, so the word argument is printed. Application fails because the operator value is not callable.

Contrast an operator expression that fails during its own evaluation:

${py("missing-operator-skips-operands", `def reveal(x):
    print(x)
    return x

missing(reveal("argument"))`, "", "NameError")}

Here name lookup fails before operand evaluation begins, so nothing is printed.

This is why “the program has an error” is not a complete trace. Locate the exact failing evaluation step and keep all earlier effects. Once the exception occurs, later operands and later statements on that execution path do not run unless the exception is handled.`,
        summary: "A resolved but noncallable operator permits operand effects before application fails; a missing operator name fails earlier and prevents operand evaluation.",
        threads: [{
          quote: "Locate the exact failing evaluation step", title: "A checklist for mixed WWPD errors", resolved: false,
          exchanges: [
            { user: "Give me a repeatable checklist for this instead of more one-off tricks.", assistant: md`For each call: resolve the operator; evaluate operands left to right; note each returned value and effect; verify application; if user-defined, create its frame and execute the body. At the first exception, stop that path and retain prior effects. Separately track whether a normal function body reaches a return or falls off the end.` },
            { user: "I'll redo the two examples without running Python and annotate exactly where each stops.", assistant: md`Good final check. Then alter the first operand to raise an error and ask whether a second operand would run. The rule should predict the answer without memorizing a specific transcript. If you cannot locate the failure step, leave the question in your error log rather than marking it mastered just because the printed output looks familiar.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-midterm",
    goal: "Consolidate the published Fall 2026 pre-Midterm-1 scope into an original rehearsal and a rule-based mistake log, excluding later recursion topics.",
    sources,
    exchanges: [
      {
        user: "I've worked through the earlier chats. Build me a final Midterm 1 map based on the actual CS61A site, not a generic Python syllabus.",
        assistant: md`## Fall 2026: a bounded review target

The [published Fall 2026 schedule](https://cs61a.org/fa26/), checked September 13, places Midterm 1 on September 14 after lectures on Functions, Control, Higher-Order Functions, Environments, Abstraction, and Function Examples. The site warns that its schedule can be revised; official exam announcements take precedence.

Use the [official Midterm 1 study guide](https://site.cs61a.org/assets/pdfs/61a-mt1-study-guide.pdf) alongside these original practice conversations.

Your checklist:

- Expressions, names, assignment, arithmetic, and call evaluation order.
- Function definitions, parameters, application, return, print, and None.
- Truthiness, and/or/not, conditional statements, and while loops.
- Environment diagrams: fresh frames, aliases, lexical parents, and shadowing.
- Higher-order arguments and returned functions, nested def, and closures.
- Lambda expressions, currying, composition, iterative repetition, and abstraction contracts.
- Boundary cases, loop invariants, and tracing effects before errors.

Recursion is scheduled after this midterm, followed by tree recursion and sequences. Do not let a generic “CS61A midterm” playlist silently expand this particular exam's scope. These are prewritten study examples, not leaked questions or official predictions.`,
        summary: "Fall 2026 MT1 follows lectures 1–7 through function examples; focus on expressions/control/HOF/environments/abstraction, and verify official announcements because recursion begins afterward.",
        threads: [{
          quote: "Recursion is scheduled after this midterm", title: "Should I study tree recursion tonight?", resolved: true,
          exchanges: [
            { user: "A practice set from another term includes recursion. Should I assume it is on this exam?", assistant: md`No. Archived exams and generic guides can reflect a different term's pacing. The current Fall 2026 schedule places the recursion lecture after Midterm 1. Check the current exam announcement for the authoritative scope, then use older problems selectively. Iterative Fibonacci is relevant to loops; recursive Fibonacci is a later topic in this schedule.` },
            { user: "Then I'll label extra problems as extensions instead of mixing them into my core readiness checklist.", assistant: md`That is sensible. A scope label prevents optional curiosity from crowding out the concepts you actually need to demonstrate. Keep the extensions available for later study, but assess tomorrow's readiness on the current announced material.` },
          ],
        }],
      },
      {
        user: "Give me an original code-writing rehearsal that combines a loop, a predicate, and a returned lambda. Include why zero is handled correctly.",
        assistant: md`## Rehearsal: count inputs satisfying a supplied test

Before reading the implementation, specify the contract: for a nonnegative integer n and a unary predicate, count the integers from 1 through n for which the predicate returns a truthy value. Then construct a predicate for divisibility by a positive divisor.

${py("midterm-count-matches", `def count_matches(n, predicate):
    count, k = 0, 1
    while k <= n:
        if predicate(k):
            count = count + 1
        k = k + 1
    return count

def divisible_by(divisor):
    return lambda value: value % divisor == 0

print(count_matches(10, divisible_by(3)))
print(count_matches(0, divisible_by(3)))`, "3\n0\n")}

At the header, count is the number of matching integers strictly below k. Increment k whether or not the current integer matches. If the increment were inside the if, a nonmatching input could leave the loop stuck forever.

For n=0, the interval is empty, the body never runs, and zero is returned. The divisor's positive precondition avoids division by zero and makes the intended exercise domain explicit.

The returned lambda captures the factory's divisor binding. Calling the factory chooses a test; calling that test checks one candidate.`,
        summary: "count_matches combines a loop invariant with a unary predicate and captured divisor; unconditional progress and the empty-input case determine correctness.",
        threads: [{
          quote: "Increment k whether or not", title: "A bug that only appears on the first nonmatch", resolved: true,
          exchanges: [
            { user: "Why did putting k += 1 inside the if work on my test where everything matched?", assistant: md`That test never exercised the failing branch. If the predicate is false for the current k, neither the count nor k changes, so the loop tests the same k again forever. Use a predicate that rejects the first candidate to reveal the problem immediately. Test selection should follow branch behavior, not just typical successful inputs.` },
            { user: "The invariant isn't enough unless I also show progress on both branches.", assistant: md`Exactly. Partial correctness says that if the loop terminates, its answer is right. Termination requires a separate progress argument. Here k increases on every iteration and is bounded by the exit threshold. Moving the update into only one branch removes that guarantee.` },
          ],
        }],
      },
      {
        user: "Last mixed trace, then summarize my actual mistake patterns so I know what to revisit rather than rereading everything.",
        assistant: md`## Final trace: a side effect does not replace the return value

${py("midterm-mixed-trace", `def trace(tag, value):
    print(tag)
    return value

def maker(x):
    return lambda y: trace("body", x + y)

f = maker(3)
print(trace("arg", 4) and f(2))`, "arg\nbody\n5\n")}

The first trace prints arg and returns 4, which is truthy. Therefore and evaluates f(2). That closure finds x=3 in its defining frame, prints body through trace, and returns 5. The outer print receives 5.

Your mistake log now has concrete rules:

1. A print effect is not a return value.
2. An argument expression is evaluated before the callee's frame exists.
3. A function's parent is its defining frame, not its caller.
4. Returning a function is not the same as calling it.
5. Closures retain binding access, not universally frozen values.
6. A loop needs progress on every continuing path, including nonmatches.

A final transfer check: change the first trace's returned value from 4 to 0. Predict which later calls disappear before checking. Knowing why the altered program behaves differently is stronger evidence of understanding than recognizing the original output.`,
        summary: "Final rehearsal combines a truthy returned value, short-circuiting, captured x, and ordered effects; the error log tracks rules rather than memorized answers.",
        threads: [{
          quote: "change the first trace's returned value from 4 to 0", title: "One changed value, a different execution path", resolved: false,
          exchanges: [
            { user: "I think it still prints body because f was already created. Is that my creation-versus-application mistake again?", assistant: md`Yes. Creating f happened earlier, but its body has not run. If the first trace returns zero, and short-circuits before f(2). Only arg is printed by trace, followed by 0 from the outer print. The closure exists without being invoked on that path.` },
            { user: "I'll leave this open until I can trace both versions and draw the frames without looking.", assistant: md`That is a meaningful stopping criterion. For the zero version, explicitly mark the f call as skipped and do not create a y-frame for it. Then explain why the maker frame can still exist even though the returned function is never called. That one contrast checks boolean evaluation, closure creation, and environment diagrams together.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-search",
    goal: "Apply higher-order functions to bounded search and inverse construction, design prime-search loops, and distinguish test assertions from ordinary output.",
    sources,
    exchanges: [
      {
        user: "The study guide has search and inverse functions. Can we build those from the loop and closure rules, including what happens when no answer exists?",
        assistant: md`## Search is a reusable process with a predicate

An unbounded search for the first satisfying nonnegative integer assumes such an integer exists. Here is a bounded version that makes failure explicit, followed by a preimage finder built from it:

${py("bounded-search-and-inverse", `def first_match(predicate, limit):
    candidate = 0
    while candidate <= limit:
        if predicate(candidate):
            return candidate
        candidate = candidate + 1
    return None

def inverse_on_nonnegative(f, limit):
    return lambda target: first_match(lambda x: f(x) == target, limit)

root = inverse_on_nonnegative(lambda x: x * x, 20)
print(first_match(lambda x: x * x >= 20, 10))
print(root(16), root(2))`, "5\n4 None\n")}

The inner predicate captures both f and the current target through its lexical environment. Each candidate is tested in order, so a successful result is the least matching nonnegative integer within the limit.

This is not a general real-valued square-root algorithm: it searches only integers in a bounded domain. It returns None for 2 because no tested integer squares to 2, not because the real square root of 2 does not exist.

If f is not injective, this routine chooses a preimage; calling it an inverse without a domain qualification would overstate its guarantee.`,
        summary: "Bounded first_match returns the least satisfying candidate or None; a captured-target predicate constructs a bounded preimage finder, not an unrestricted inverse.",
        threads: [{
          quote: "chooses a preimage", title: "A preimage finder is not always a two-sided inverse", resolved: true,
          exchanges: [
            { user: "If f maps several inputs to the same output, which input would the search return?", assistant: md`The smallest tested one. For f(x)=x modulo 3, searching for a preimage of 1 returns 1 even though 4 and 7 also map to 1. Consequently, applying the finder after f does not recover every original input: starting from 4 gives f(4)=1, then the finder returns 1 rather than 4.` },
            { user: "So the domain and injectivity assumptions are part of the abstraction contract.", assistant: md`Exactly. On a restricted domain where f is injective and the target is in its searched image, the finder can act as an inverse. Without those conditions, it is better described as selecting a preimage, with an explicit failure result when no candidate is found. The mathematics and the programming contract agree.` },
          ],
        }],
      },
      {
        user: "Can we do a nearest-prime problem like the function-implementation practice? State the tie rule instead of making me guess it.",
        assistant: md`## Search by distance, then encode the tie rule

Contract: for a nonnegative integer n, return the nearest prime; if two primes are equally close, choose the larger. First make primality itself reliable:

${py("nearest-prime-boundaries", `def is_prime(n):
    if n < 2:
        return False
    divisor = 2
    while divisor * divisor <= n:
        if n % divisor == 0:
            return False
        divisor = divisor + 1
    return True

def nearest_prime(n):
    distance = 0
    while True:
        if is_prime(n + distance):
            return n + distance
        if is_prime(n - distance):
            return n - distance
        distance = distance + 1

print(is_prime(1), is_prime(2), is_prime(25))
print(nearest_prime(12), nearest_prime(4), nearest_prime(1))`, "False True False\n13 5 2\n")}

At each distance, every smaller distance has already been ruled out. Checking the upper candidate first implements the stated tie rule. Negative lower candidates are harmless because the primality predicate rejects all numbers below two.

The divisor loop includes equality so that perfect squares are not mistakenly accepted. A composite number has a factor no larger than its square root, which justifies the stopping condition without needing floating-point square roots.

This is an original worked variant for practicing contracts and loops, not a prediction of an exam question.`,
        summary: "Nearest-prime search increases distance and checks the upper candidate first for larger-prime ties; primality rejects n<2 and tests divisors through the square-root boundary inclusively.",
        threads: [{
          quote: "perfect squares are not mistakenly accepted", title: "Why the square-root boundary needs equality", resolved: true,
          exchanges: [
            { user: "I used divisor * divisor < n. Which smallest examples reveal the problem?", assistant: md`Try 4 and 9. With a strict inequality, the loop can stop just before checking the divisor equal to the square root. For 4, divisor starts at 2 and 2×2<4 is false, so the buggy function would immediately return True. Including equality tests the missing factor.` },
            { user: "And testing just 7 and 12 wouldn't reliably catch that exact boundary bug.", assistant: md`Right. Prime examples and ordinary composites are useful, but perfect squares exercise a distinct boundary. Also test 0, 1, and 2 to cover the definition's lower edge. Choose examples because of the path or inequality they probe, not only because they are small familiar numbers.` },
          ],
        }],
      },
      {
        user: "Finish with testing: what do assert statements and doctest examples actually check, and how should I choose inputs for these functions?",
        assistant: md`## A test is an executable claim, not extra output

${py("assertions-and-return-values", `def twice(x):
    return x + x

assert twice(3) == 6
assert twice(0) == 0
assert twice(-2) == -4
print(twice(3))
assert twice(3) == 7`, "6\n", "AssertionError")}

The final assertion is deliberately false. Successful assertions produce no output; a failed one raises AssertionError and stops this unhandled execution. The earlier printed 6 remains visible. In normal Python execution, assert tests a condition; it does not print the expected answer or change what the function returns.

A doctest example written with an interactive prompt, such as \`>>> twice(3)\` followed by \`6\`, describes an interpreter transcript. The displayed result can come from interactive expression display even though twice itself contains no print call. Keep that distinction from our script-output boxes.

For search, test a match at zero, at the limit, and no match. For nearest prime, test an input that is prime, a tie, and a number below two. For higher-order code, test both the arity and return behavior expected of the supplied callable.

Passing examples supports a claim; it is not a proof over every input. Use the contract and invariant to explain why the tests should pass.`,
        summary: "Assertions check conditions and are silent on success; doctests model interpreter transcripts, while purposeful boundary tests complement contract and invariant reasoning.",
        threads: [{
          quote: "both the arity and return behavior", title: "Testing a zero-argument dice function without real randomness", resolved: false,
          exchanges: [
            { user: "For a Hog-style helper that calls a dice function, should I test with actual random rolls?", assistant: md`Use a predictable supplied callable for a reproducible unit test. A zero-argument function that always returns 4 lets you test a simple roll total without random variation. Passing the number 4 is not equivalent: the helper's contract expects something it can call. More involved tests need controlled sequences and checks on how many rolls are consumed.` },
            { user: "I want to check the number of calls too, not just whether the final total coincidentally matches.", assistant: md`Good next step. A fake dice function can make its calls observable in a test harness, so you can compare the sequence of calls with your prediction. Do not add random retries until an incorrect result happens to look right. Keep this thread open as an exercise in testing behavior at a higher-order interface; stateful sequence fakes introduce additional implementation details beyond the simple constant callable.` },
          ],
        }],
      },
    ],
  },
];
