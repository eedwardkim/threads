import type { DemoConversation } from "./demo-catalog";
import { md, pythonWorkbook } from "./demo-format";

const { examples: pythonExamples, py } = pythonWorkbook();
export { pythonExamples };
const sources = [
  "CS61A Fall 2026 schedule, checked 13 September 2026: https://cs61a.org/fa26/",
  "Official CS61A Midterm 1 study guide: https://site.cs61a.org/assets/pdfs/61a-mt1-study-guide.pdf",
];

export const conversations: DemoConversation[] = [
  {
    id: "demo-cs-expressions",
    goal: "Trace Python expressions in evaluation order, distinguish names from values, and handle arithmetic edge cases before studying functions.",
    sources,
    exchanges: [
      {
        user: "I'm starting CS61A from the beginning. What does 'evaluate the operator and then the operands' actually mean? Don't just tell me inside-out.",
        assistant: md`## A call is a small evaluation procedure

For a call expression, evaluate the operator expression first, then the operand expressions from left to right, then apply the resulting function to the resulting arguments. “Inside-out” is not precise enough when the operator is itself a call.

${py("operator-before-operands", `def choose():
    print("operator")
    return lambda a, b: a + b

def operand(label, value):
    print(label)
    return value

print(choose()(operand("left", 2), operand("right", 3)))`, "operator\nleft\nright\n5\n")}

The operator of the inner application is \`choose()\`, which evaluates to a function. Next, the two operand calls produce 2 and 3. Only then is that returned function applied. The outer print runs after its whole argument has become 5.

Use three columns in your scratch work: **expression being evaluated**, **value produced**, and **side effect printed**. A printed label is not the value of the expression that printed it.`,
        summary: "Evaluate a call's operator first, operands left to right, then apply; track return values separately from printed effects.",
        threads: [{
          quote: "the operator is itself a call", title: "How can the operator be more than a name?", resolved: true,
          exchanges: [
            { user: "In choose()(2, 3), are we calling choose with two arguments?", assistant: md`No. First \`choose()\` calls \`choose\` with zero arguments. Its return value becomes the operator for a second call with arguments 2 and 3. Read the expression as \`(choose())(2, 3)\`. The first function creates or retrieves a callable; the second application uses it.` },
            { user: "So each pair of parentheses can represent a different function application.", assistant: md`Yes. Count applications, not just function names. If the first call returned an integer instead of a callable, the second application would fail with a TypeError. That is the same distinction you will use for curried functions and lambda call chains later.` },
          ],
        }],
      },
      {
        user: "When I assign one function name to another and then reassign the original name, does the alias change too?",
        assistant: md`## Names bind to values, not to other names

${py("function-alias-rebinding", `from operator import add

combine = add
add = 17
print(combine(2, 3))
print(add)`, "5\n17\n")}

The assignment \`combine = add\` first looks up the current value of \`add\`, then binds \`combine\` to that function value. It does not create a permanent forwarding link to the name \`add\`.

Reassigning \`add\` changes one binding. The earlier function object remains available through \`combine\`. This is why environment diagrams draw arrows from names to values rather than arrows that mean “whatever this other variable becomes.”

The same reasoning applies to ordinary values. Assignment does not evaluate the entire program again whenever a name changes.

On a trace, write the value of the right-hand side before updating the left-hand binding. That habit prevents accidental backward updates to aliases and prepares you for function parameters, which are also names bound to argument values.`,
        summary: "Assignment evaluates the right side and binds its value; rebinding an original name does not redirect another existing function alias.",
        threads: [{
          quote: "It does not create a permanent forwarding link", title: "Does rebinding a builtin erase the original builtin?", resolved: true,
          exchanges: [
            { user: "If I write abs = 5, did I destroy Python's absolute-value function?", assistant: md`You shadowed the name in your current namespace; you did not mutate the builtin function itself. A saved alias still refers to the function. Avoid shadowing builtins in ordinary code because it makes later calls confusing, but in a WWPD problem, follow the actual bindings rather than what the name usually means.` },
            { user: "Then abs(-3) after that assignment tries to call 5.", assistant: md`Right. The operator lookup produces an integer, not the builtin function you expected. Applying that value as a function raises TypeError. The spelling of a name does not override the value currently bound to it.` },
          ],
        }],
      },
      {
        user: "Give me the arithmetic edge cases I should stop guessing about: negative floor division, remainder, and exponent precedence.",
        assistant: md`## Predict, then check the rule

${py("arithmetic-boundaries", `print(17 // 5, 17 % 5)
print(-17 // 5, -17 % 5)
print(2 + 3 * 4, (2 + 3) * 4)
print(2 ** 3 ** 2, (-2) ** 2, -2 ** 2)
print(5 / 2, 5 // 2)`, "3 2\n-4 3\n14 20\n512 4 -4\n2.5 2\n")}

Integer floor division rounds down, not toward zero. The quotient and remainder satisfy \`a == (a // b) * b + a % b\` for nonzero integer \`b\`; with positive divisor 5, the remainder lies from 0 through 4.

Exponentiation groups to the right, so \`2 ** 3 ** 2\` means \`2 ** (3 ** 2)\`. Parenthesizing a negative base matters: \`-2 ** 2\` means the negation of \`2 ** 2\`.

For CS61A's digit problems, the nonnegative-integer domain is often intentional. Extending a loop written for positive integers to negatives without examining floor division can create a loop that never reaches zero.`,
        summary: "Floor division rounds toward negative infinity; quotient/remainder identities and exponentiation precedence explain common arithmetic traps.",
        threads: [{
          quote: "a loop that never reaches zero", title: "Why repeatedly doing -1 // 10 does not terminate", resolved: false,
          exchanges: [
            { user: "I assumed dividing any integer by ten enough times eventually gives zero.", assistant: md`Not with Python floor division on negative integers. \`-1 // 10\` is -1, so once a loop reaches -1 it stays there. A loop such as “while n is nonzero, replace n by n // 10” can therefore fail to terminate for negative input.` },
            { user: "For a digit-sum function I should state the domain or normalize the sign first.", assistant: md`Exactly. If the contract permits negative inputs and you want the sum of decimal digit magnitudes, set \`n = abs(n)\` first. If the assignment specifies a nonnegative integer, preserve that assumption in your reasoning. A termination proof needs a quantity that actually moves toward the stopping condition on the stated domain.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-print",
    goal: "Separate effects, expression values, explicit returns, implicit None, and error timing in WWPD questions.",
    sources,
    exchanges: [
      {
        user: "I keep replacing a print call with whatever it prints. Please make print versus return unambiguous.",
        assistant: md`## A visible effect and a returned value are different

${py("print-versus-return", `def display(x):
    print(x)

def square(x):
    return x * x

print(display(4))
print(square(4))`, "4\nNone\n16\n")}

Calling \`display(4)\` prints 4 inside its body, then reaches the end without an explicit return value. Its value is therefore \`None\`. The outer print receives that value and prints the word None.

Calling \`square(4)\` returns 16 without printing inside its body. The outer print is what makes 16 visible.

A print call itself returns None. A return statement immediately ends the current function call and hands a value to its caller. In a script, a bare expression is not automatically displayed; an interactive Python prompt may display a non-None expression result. Know which convention a WWPD question is using.

Useful annotation: write \`prints: 4; returns: None\` instead of treating the two as a single “output.”`,
        summary: "print produces an effect and returns None; return supplies a value and exits the current call; script output differs from interactive display.",
        threads: [{
          quote: "A print call itself returns None.", title: "Why assignment to a print call does not save the printed number", resolved: true,
          exchanges: [
            { user: "If result = print(8), is result 8?", assistant: md`No. The right-hand side executes, prints 8, and evaluates to None. Assignment binds \`result\` to None. An assignment statement does not separately display that bound value. Later, \`print(result)\` would print None.` },
            { user: "What if I write return print(8) inside a function?", assistant: md`It prints 8 and returns None from the function, because the return expression is the print call and that call's value is None. It does not mean “print 8 and also return 8.” To do both, use separate statements: print the value, then return the value.` },
          ],
        }],
      },
      {
        user: "Okay, now nested print calls. What happens before the outer print even starts?",
        assistant: md`## Finish the arguments before applying the outer function

${py("nested-print", `print(print(1), print(2))`, "1\n2\nNone None\n")}

The first operand prints 1 and becomes None. The second prints 2 and becomes None. Only then is the outer print applied to two arguments, both None. Its default separator puts a space between them.

The outer call does not print its function name, the text of its arguments, or the return value of itself. It formats the argument values after they have been computed.

This remains true when the operands include boolean expressions:

${py("nested-print-short-circuit", `print(print("A") or 0, print("B") and 9)`, "A\nB\n0 None\n")}

The first print returns a falsey None, so \`or\` evaluates and returns 0. The second print returns None, so \`and\` stops there instead of returning 9. None is falsey; the fact that a call printed something does not make its return value truthy.`,
        summary: "Nested print arguments execute left to right before the outer print; None drives short-circuit behavior independently of visible side effects.",
        threads: [{
          quote: "the fact that a call printed something", title: "Does printed text affect the truth value of the call?", resolved: true,
          exchanges: [
            { user: "Even print('True') is falsey when used in a condition?", assistant: md`The call returns None, so a condition using its result is falsey, regardless of the text it displayed. The string \`'True'\` itself is truthy, but \`print('True')\` is not that string. You must distinguish an argument's value from the called function's return value.` },
            { user: "Then print('False') and print('True') have the same return value.", assistant: md`Yes: both return None. Their visible effects differ, but their expression values are the same singleton value. In tracing problems, do not infer the expression value from the spelling of what appeared in the terminal.` },
          ],
        }],
      },
      {
        user: "What does a bare return do, and how do I trace code after an early return?",
        assistant: md`## Return exits this call immediately

${py("early-return-and-none", `def choose(x):
    print("start")
    if x > 0:
        return x + 1
    print("nonpositive")
    return

print(choose(2))
print(choose(0))`, "start\n3\nstart\nnonpositive\nNone\n")}

For the positive input, the return inside the if ends that call; the later print is not executed. For zero, control reaches the later print and then the bare return, which returns None.

A function reaching the end of its body also returns None. This is not an error and is different from an unbound name. An outer caller may, however, misuse None by trying to add it to a number or call it.

After a return, resume the expression in the caller that was waiting for the function's value. Do not continue through the rest of the callee's body, and do not accidentally terminate the entire surrounding program.`,
        summary: "A return exits only the current call; bare return and falling off the end both return None, and subsequent errors depend on how callers use that value.",
        threads: [{
          quote: "misuse None by trying to add it to a number", title: "Printed effects can happen before an exception", resolved: false,
          exchanges: [
            { user: "What exactly appears for print(print(5) + 1)?", assistant: md`${py("print-before-type-error", `print(print(5) + 1)`, "5\n", "TypeError")}

The inner print already happened. Its result is None, and adding 1 fails. The outer print never gets an argument value, so it is never applied.` },
            { user: "I was writing just Error and erasing the earlier printed 5.", assistant: md`Preserve all effects that occurred before the exception. Execution stops at the failing step; it does not undo earlier output. For a WWPD answer, record preceding lines and then the error according to the course's notation. The full traceback text is not normally the conceptual target unless explicitly requested.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-control",
    goal: "Evaluate truthiness and short-circuit expressions precisely, distinguish conditional syntax from eager function arguments, and trace branch selection.",
    sources,
    exchanges: [
      {
        user: "Does and always return True or False? I got a string back and now I don't trust my understanding.",
        assistant: md`## and and or choose operand values

For \`a and b\`, evaluate \`a\`; if it is falsey, return it without evaluating \`b\`. Otherwise evaluate and return \`b\`. For \`a or b\`, return a truthy \`a\` immediately; otherwise evaluate and return \`b\`.

${py("boolean-operand-values", `print(0 or 7)
print(4 and 9)
print("" and 10)
print(not "")
print(None or "fallback")`, "7\n9\n\nTrue\nfallback\n")}

The blank third line comes from printing the empty string. \`not\` is different: it returns a boolean.

Among the values used early in CS61A, zero, False, the empty string, and None are falsey. Nonempty strings, including \`'False'\`, are truthy. A function value is truthy too; that is not the same as calling the function and testing its result.

To trace a chain, mark which operands are actually evaluated before deciding its final value. Skipped operands have no effects and cannot raise an error during that evaluation.`,
        summary: "and/or short-circuit and return selected operand values, while not returns a bool; distinguish a function object from its result.",
        threads: [{
          quote: "A function value is truthy too", title: "Testing a predicate versus testing its function object", resolved: true,
          exchanges: [
            { user: "If is_even is a function, why does 'if is_even' always enter the branch?", assistant: md`Because you tested the function object, which is truthy, rather than applying it to an input. To test whether a number is even, the condition should call the predicate, such as \`is_even(n)\`. Those expressions evaluate to different kinds of values: a callable versus its returned result.` },
            { user: "So forgetting parentheses can be a logical bug without raising any exception.", assistant: md`Exactly. Python can legally test a callable's truth value, so a missing application is not necessarily a syntax or type error. Include test cases on both sides of the intended predicate: an even and an odd input would expose a branch that always executes.` },
          ],
        }],
      },
      {
        user: "Why can Python's conditional expression safely skip division by zero, while my select function can't?",
        assistant: md`## A language construct can control evaluation

${py("conditional-versus-eager-call", `def select(flag, yes, no):
    return yes if flag else no

print(10 if True else 1 / 0)
print(select(True, 10, 1 / 0))`, "10\n", "ZeroDivisionError")}

The conditional expression evaluates the condition and only the chosen branch. The ordinary call must evaluate all of its operand expressions before entering \`select\`. The division fails during argument evaluation, so the function never gets to choose anything.

This is the difference between passing a computation's value and passing a delayed computation. Later, you can pass zero-argument functions and have the selector call only the chosen one, but that changes the interface.

Likewise, \`1 or 1 / 0\` is safe because \`or\` stops at the first truthy operand. The skipped expression is not “evaluated and ignored”; it is not evaluated at all. That distinction governs both errors and side effects.`,
        summary: "Conditional and boolean syntax can skip evaluation; an ordinary function receives already-evaluated arguments unless explicitly given delayed callables.",
        threads: [{
          quote: "passing a delayed computation", title: "Can zero-argument functions recreate the safe choice?", resolved: false,
          exchanges: [
            { user: "Show me the delayed version, but explain what is and isn't evaluated when I construct the lambdas.", assistant: md`${py("delayed-selector", `def select_call(flag, yes, no):
    return yes() if flag else no()

print(select_call(True, lambda: 10, lambda: 1 / 0))`, "10\n")}

Both lambda expressions are evaluated to create function values before the call. Their bodies are not run then. Inside the selector, only \`yes()\` is called.` },
            { user: "I still want to draw those two lambdas' parent frames when we get to environments.", assistant: md`Both lambdas in this example are created in the global frame, so both have that parent. The selector's local names \`yes\` and \`no\` point to those existing function values; passing them as arguments does not change their parents. Revisit this with a lambda created inside an outer function to test lexical scope.` },
          ],
        }],
      },
      {
        user: "I also mix up two if statements with if/elif. Can changing a variable in the first branch affect whether the elif runs?",
        assistant: md`## One conditional chooses at most one suite

${py("if-elif-versus-separate-if", `x = 2
if x > 0:
    print("positive")
    x = -1
elif x < 0:
    print("negative")

if x < 0:
    print("checked again")`, "positive\nchecked again\n")}

Once the first if clause is selected, the remaining elif/else clauses of that same statement are skipped. Changing \`x\` inside the suite does not restart the clause selection. The later separate if statement is a new decision, so it sees the updated value.

Also remember precedence: \`and\` binds more tightly than \`or\`. Use parentheses in your own code when they clarify intent rather than relying on a reader's memory.

A chained comparison such as \`a < b < c\` checks two comparisons with short-circuiting and evaluates the middle expression once. It does not compare a boolean result with \`c\`. These are evaluation rules, not just stylistic preferences.`,
        summary: "if/elif selects at most one suite, separate if statements reevaluate current bindings, and comparison chains are not left-associated boolean arithmetic.",
        threads: [{
          quote: "It does not compare a boolean result", title: "A counterexample for chained comparisons", resolved: true,
          exchanges: [
            { user: "Can you give me numbers where the wrong left-to-right interpretation changes the answer?", assistant: md`${py("chained-comparison", `print(3 < 2 < 1)
print((3 < 2) < 1)
print(1 or 0 and 0)
print((1 or 0) and 0)`, "False\nTrue\n1\n0\n")}

The first chain is false at its first comparison. In the parenthesized expression, \`3 < 2\` becomes False, which compares numerically like zero, and zero is less than one.` },
            { user: "So parentheses can change the parse, not just make the same expression easier to read.", assistant: md`Yes. First determine how an expression groups, then apply the evaluation rules to that structure. “Go left to right” describes operand evaluation within a call, not a universal rule for parsing every Python operator. Keeping parsing and evaluation separate saves many WWPD mistakes.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-iteration",
    goal: "Design and verify while loops with initialization, invariants, progress, boundary cases, and simultaneous assignment.",
    sources,
    exchanges: [
      {
        user: "I can usually make a while loop work for n = 5, but then zero or one breaks it. How should I design the loop instead of patching cases?",
        assistant: md`## State what the variables mean at the loop header

${py("factorial-loop", `def factorial(n):
    product, k = 1, 1
    while k <= n:
        product = product * k
        k = k + 1
    return product

print(factorial(0), factorial(1), factorial(5))`, "1 1 120\n")}

Contract: \`n\` is a nonnegative integer. At the header, \`product\` is the product of integers from 1 through \`k - 1\`. Initially this is an empty product, equal to one. Each iteration includes the next factor and increments \`k\`.

When the loop stops, \`k = n + 1\` and the product is the desired factorial. For zero, the body runs zero times and the initial value is already correct.

Check four things: initialization establishes the meaning; the body preserves it; progress reaches the stopping condition; and the invariant plus stopping condition implies the answer. This is much stronger than observing that one example happens to work.`,
        summary: "A loop invariant plus initialization, progress, and exit reasoning explains factorial including the zero-iteration case.",
        threads: [{
          quote: "the body runs zero times", title: "Why the initial accumulator depends on the operation", resolved: true,
          exchanges: [
            { user: "Why start product at one but a total at zero?", assistant: md`They are identity values for their operations. Multiplying by one leaves an accumulated product unchanged, while adding zero leaves an accumulated sum unchanged. They also make empty products and empty sums behave consistently with the rest of the algorithm. Starting a product at zero would force every later product to remain zero.` },
            { user: "So I should derive the starting value from what the empty prefix means.", assistant: md`Exactly. Before any items have been processed, ask what result represents that empty prefix. For operations without a convenient identity on the permitted domain, you may need a different initialization strategy or a precondition that the input is nonempty. Do not copy zero mechanically from another loop.` },
          ],
        }],
      },
      {
        user: "Let's do decimal digits with % and //. Include a negative input and zero so I can see the contract clearly.",
        assistant: md`## Peel off one digit while preserving a total

${py("sum-digits", `def sum_digits(n):
    n = abs(n)
    total = 0
    while n > 0:
        total = total + n % 10
        n = n // 10
    return total

print(sum_digits(507), sum_digits(-507), sum_digits(0))`, "12 12 0\n")}

Here \`n\` stores the unprocessed prefix of the original magnitude, and \`total\` stores the sum of digits already removed. Remainder by ten extracts the last digit; floor division by ten removes it because the working value is nonnegative.

A digit **count** has a different zero case: the decimal representation of zero has one digit, though this sum loop needs no iterations to return zero. Related tasks need not share every boundary condition.

If you place the return inside the loop, the function returns after processing only one digit. If you forget to update \`n\`, the loop can keep processing the same digit forever. Trace the changing state, not just the arithmetic expression.`,
        summary: "Digit peeling uses remainder and floor division on a nonnegative working value; sum, count, termination, and return placement have distinct boundary requirements.",
        threads: [{
          quote: "the function returns after processing only one digit", title: "Why a return inside the loop is not a running answer", resolved: true,
          exchanges: [
            { user: "I thought returning total each iteration lets it keep updating and eventually return the last total.", assistant: md`A normal function return does not publish an interim result and continue. It exits the call immediately. In a digit-sum loop, a return at the end of the body means only the first iteration can run. Put the return after the loop if the intended result depends on all digits.` },
            { user: "And zero input might then fall off the end and give None instead of zero.", assistant: md`Exactly. If the only return is inside a loop that executes zero times, the function reaches the end and returns None. Testing both a multi-digit input and zero exposes the two different failures. That is a good example of choosing tests from control-flow paths rather than random numbers.` },
          ],
        }],
      },
      {
        user: "Why does Fibonacci use simultaneous assignment? I keep turning it into two separate assignments because that feels clearer.",
        assistant: md`## Evaluate both right-hand expressions before rebinding

${py("iterative-fibonacci", `def fib(n):
    previous, current = 0, 1
    k = 0
    while k < n:
        previous, current = current, previous + current
        k = k + 1
    return previous

print(fib(0), fib(1), fib(7))
a, b = 0, 1
a = b
b = a + b
print(a, b)`, "0 1 13\n1 2\n")}

At the loop header, the invariant is \`previous = F(k)\` and \`current = F(k+1)\`. The simultaneous assignment computes both right-hand values from the old bindings, then updates both names.

The separate assignments at the end do something else: by the time \`b = a + b\` runs, \`a\` already holds the old \`b\`. You have lost the older value needed for the sum.

A temporary variable can make the sequential version correct, but simply splitting the line is not equivalent. This is iteration, not recursive Fibonacci; recursion appears after Midterm 1 on the current Fall 2026 schedule.`,
        summary: "Simultaneous assignment computes all right-hand values before rebinding; iterative Fibonacci maintains consecutive Fibonacci values without recursion.",
        threads: [{
          quote: "You have lost the older value", title: "Translate a parallel update using a temporary variable", resolved: false,
          exchanges: [
            { user: "Can I still write it as separate statements if I save the old value?", assistant: md`Yes. Save \`old_previous = previous\`, assign \`previous = current\`, then assign \`current = old_previous + current\`. At the last line, \`current\` still holds the old current value. The temporary preserves exactly the information the simultaneous form keeps while evaluating its right side.` },
            { user: "I want to do a three-variable rotation next without losing track.", assistant: md`Try translating \`a, b, c = b, c, a\` into sequential assignments. Start with three distinct values and verify the result, then explain why at least one old value must be saved before overwriting it. Keep this open until you can derive the update from the invariant instead of memorizing a swap pattern.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-environments",
    goal: "Draw environment diagrams using the function-definition and function-call rules, including aliases and lexical rather than dynamic lookup.",
    sources,
    exchanges: [
      {
        user: "I need a mechanical environment-diagram procedure. When do I make a function object, and when do I make a new frame?",
        assistant: md`## Definition creates a function; application creates a call frame

Executing a def statement creates a function value, records its parent as the current frame, and binds its name there. It does not execute the body.

Applying a user-defined function creates a fresh local frame, gives that frame the function's recorded parent, binds parameters to argument values, and executes the body.

${py("function-alias-frames", `def square(x):
    return x * x

alias = square
print(alias(3))
print(square(4))`, "9\n16\n")}

In the global frame, both \`square\` and \`alias\` point to the same function value. The two calls still create two different local frames: one with \`x = 3\` and another with \`x = 4\`. Both frames have the global frame as parent.

A function's intrinsic name and the variable used to call it need not match. Follow arrows to the function object rather than renaming the object every time another variable refers to it.`,
        summary: "def creates a function with a recorded parent; every user-function application creates a fresh frame, and aliases point to the same function value.",
        threads: [{
          quote: "two different local frames", title: "Why not reuse the first call's frame?", resolved: true,
          exchanges: [
            { user: "If it's the same function object, why not just replace x in the old frame?", assistant: md`A function value describes behavior and its lexical parent; a call frame records one particular invocation. Reusing one frame would conflate distinct invocations and break cases where a returned inner function retains access to an earlier call's bindings. Fresh frames keep those histories separate.` },
            { user: "So one function object can be associated with many call frames.", assistant: md`Exactly. Think “one recipe, many executions,” while remembering that the recipe also carries its defining environment. In a diagram, creating another alias is not another function definition, and calling an alias is still a new invocation of the existing function.` },
          ],
        }],
      },
      {
        user: "The big one: does a function look for variables in the caller's frame, or where it was defined?",
        assistant: md`## The caller is not automatically the parent

${py("lexical-not-dynamic-scope", `x = 10

def f(y):
    return x + y

def g(x):
    return f(1)

print(g(100))`, "11\n")}

The call to \`g\` creates a local frame with \`x = 100\`. But \`f\` was defined globally, so its call frame's parent is global, not the \`g\` frame. Inside \`f\`, lookup finds \`y = 1\` locally and \`x = 10\` globally.

A compact diagram is:

\`\`\`text
Global: x → 10, f → func f(y) [parent=Global], g → func g(x) [parent=Global]
f1: g(x=100) [parent=Global]
f2: f(y=1)   [parent=Global] → returns 11
\`\`\`

The fact that \`g\` called \`f\` is part of the execution history. It does not rewrite the lexical parent stored in \`f\`. This is lexical scope, not dynamic scope.`,
        summary: "A call frame inherits its function's defining parent, not its caller; the global f reads global x=10 even when called from g(x=100).",
        threads: [{
          quote: "It does not rewrite the lexical parent", title: "What changes if f is defined inside g instead?", resolved: true,
          exchanges: [
            { user: "If I move the def f inside g, then would f see the 100?", assistant: md`Yes, in this example. Executing that nested def during \`g(100)\` creates a new function whose parent is that \`g\` call frame. A subsequent call to the inner \`f\` follows its parent link there and finds \`x = 100\`. Moving a definition can change its lexical environment even if its body text stays the same.` },
            { user: "The parent is chosen at definition time, not figured out from whoever happens to call it later.", assistant: md`That is the central rule. Write the parent annotation when you create the function object, then copy it onto each new call frame for that function. Do not postpone parent choice until you see a call site.` },
          ],
        }],
      },
      {
        user: "Where are argument expressions evaluated? I sometimes start the callee frame too early and use the wrong x.",
        assistant: md`## Arguments are computed in the calling environment

${py("caller-evaluates-arguments", `def f(x):
    return x + 1

def g(x):
    return f(x * 2)

print(g(3))`, "7\n")}

While executing \`g\`, the expression \`x * 2\` is evaluated in \`g\`'s environment, producing 6. Only after the operator and operands are ready is a frame created for \`f\` with its parameter \`x\` bound to 6.

Then \`f\` evaluates its own body in its own environment and returns 7. The two local bindings named \`x\` are not the same binding.

Do not pass the text \`x * 2\` into the diagram as though ordinary Python delays it. Pass the value 6. Similarly, returning 7 hands a value back to the waiting call expression; it does not create a global variable called return.

A reliable trace alternates between evaluating an expression in the current environment and applying a function in a newly created environment.`,
        summary: "Operand expressions use the caller's environment; the callee gets evaluated values in new parameter bindings and executes its body in its own lexical environment.",
        threads: [{
          quote: "are not the same binding", title: "Do equal variable names connect different frames?", resolved: false,
          exchanges: [
            { user: "If both frames call their parameter x, can changing one change the other?", assistant: md`Rebinding one local name does not rebind the name in another frame. Names are looked up within a particular environment; their spelling alone does not make them the same storage location. Later, mutable objects can be shared by multiple bindings, but that is different from the bindings themselves being identical.` },
            { user: "For MT1 I should stick to name/value bindings and not import mutation rules prematurely.", assistant: md`Yes. On the current course schedule, mutation is later material. For now, distinguish separate frames, evaluated argument values, and lexical parent links. When you eventually study shared mutable objects, add that object-level model without discarding the binding rules you have learned here.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-cs-hof",
    goal: "Treat functions as values, generalize repeated computational structure, and understand higher-order parameters and accumulator contracts.",
    sources,
    exchanges: [
      {
        user: "A higher-order function takes a function, but what exactly gets passed? Is it the name, the body, or a return value?",
        assistant: md`## The argument is a function value

${py("apply-twice", `def square(x):
    return x * x

def apply_twice(f, x):
    return f(f(x))

print(apply_twice(square, 2))`, "16\n")}

The operand \`square\` evaluates to a function value without calling it. The local parameter \`f\` is bound to that value. In the body, the inner \`f(2)\` returns 4, and the outer \`f(4)\` returns 16.

Passing \`square(2)\` would instead pass the number 4. If the receiving function then tried to call that value, it would fail. Parentheses are not optional decoration; they distinguish referring to a function from applying it.

A higher-order function may take a function argument, return a function, or both. The pattern is useful because it separates a reusable process from the behavior plugged into that process. The parameter name \`f\` is not special syntax; ordinary argument binding does the work.`,
        summary: "Higher-order parameters receive function values via ordinary binding; passing square differs from passing square(2), and apply_twice creates two applications.",
        threads: [{
          quote: "The local parameter", title: "Does passing a function change its parent environment?", resolved: true,
          exchanges: [
            { user: "Since square is now stored in apply_twice's local frame, does its parent become that frame?", assistant: md`No. Binding another name to a function value does not recreate the function or change its lexical parent. \`square\` was defined globally, so both calls through \`f\` create square-call frames whose parent is global. The higher-order caller supplies arguments, not a new parent link.` },
            { user: "Then the environment diagram still uses the same function object arrow as an alias would.", assistant: md`Exactly. Passing a function as an argument is not a special scope operation. It is the same value-binding idea you used for \`alias = square\`, now happening in a parameter binding for a particular call.` },
          ],
        }],
      },
      {
        user: "Show me an abstraction that actually removes repetition. I don't want a higher-order function just for the sake of one.",
        assistant: md`## Keep the summation process; vary the term

${py("summation-abstraction", `def summation(n, term):
    total, k = 0, 1
    while k <= n:
        total, k = total + term(k), k + 1
    return total

def identity(k):
    return k

def cube(k):
    return k * k * k

print(summation(5, identity))
print(summation(5, cube))`, "15\n225\n")}

The loop structure is identical for summing integers and summing cubes. The higher-order parameter identifies the part that changes: how to turn an index into a term.

The invariant is that \`total\` contains the sum for indices below \`k\`. The contract asks \`term\` to accept one index and return a value compatible with addition to the accumulator.

The abstraction does not make every callable a valid input. A function that returns None, needs two arguments, or raises on a permitted index may violate the intended contract. Dynamic typing does not remove interface requirements; it often moves their enforcement to runtime.`,
        summary: "Summation abstracts a stable loop while varying a unary term function; higher-order interfaces still impose arity and return-value requirements.",
        threads: [{
          quote: "Dynamic typing does not remove interface requirements", title: "What if I pass print as the term function?", resolved: true,
          exchanges: [
            { user: "print takes an argument, so why wouldn't summation(3, print) work?", assistant: md`Arity alone is not the whole contract. On the first iteration, \`print(1)\` would display 1 and return None. The summation body then tries to add None to the numeric total and fails. The supplied function must return a suitable term, not merely accept the right number of arguments.` },
            { user: "So I should write the input and output role of each function parameter.", assistant: md`Yes. For \`term\`, think “index to summable value.” For a predicate, think “input to a truth-tested result.” For a combiner, think “accumulator and term to next accumulator.” Those roles make higher-order code easier to design and debug than vague names alone.` },
          ],
        }],
      },
      {
        user: "Can I generalize the summation loop to products too, and what assumptions does that introduce?",
        assistant: md`## Make the combination rule explicit

${py("accumulate-abstraction", `from operator import add, mul

def accumulate(combiner, base, n, term):
    total, k = base, 1
    while k <= n:
        total = combiner(total, term(k))
        k = k + 1
    return total

print(accumulate(add, 0, 4, lambda k: k))
print(accumulate(mul, 1, 4, lambda k: k))
print(accumulate(add, 0, 0, lambda k: k))`, "10\n24\n0\n")}

The base handles the empty prefix, \`term\` generates the next value, and \`combiner\` updates the accumulator. The loop calls the combiner in a specific left-to-right order.

That order matters for noncommutative or nonassociative operations. Do not silently reorder calls because sums and products of small integers happened to allow it. Side-effecting functions make the sequence observable too.

A good abstraction exposes the pieces that genuinely vary while retaining a clear contract. If a proposed generalization makes the simple use cases harder to reason about without serving a real variation, it may be abstraction for its own sake.`,
        summary: "accumulate separates base, term, and binary combiner while preserving a specific left fold and well-defined empty-input behavior.",
        threads: [{
          quote: "a specific left-to-right order", title: "What if the combiner is subtraction?", resolved: false,
          exchanges: [
            { user: "Would using subtraction just alternate signs like an ordinary written expression?", assistant: md`Trace the actual update. With base 0 and terms 1, 2, 3, the accumulator becomes -1, then -3, then -6. The process computes \`((0 - 1) - 2) - 3\`. A right-associated expression \`0 - (1 - (2 - 3))\` is a different computation.` },
            { user: "I'll test this with a combiner that prints its arguments so I can see the fold direction.", assistant: md`That is a useful diagnostic. Predict the argument pairs first: (0, 1), (-1, 2), and (-3, 3). Then instrument the combiner and compare. The point is to derive evaluation order from the loop, not from a mathematical operation's familiar notation.` },
          ],
        }],
      },
    ],
  },
];
