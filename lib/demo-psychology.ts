import type { DemoConversation } from "./demo-catalog";
import { md } from "./demo-format";

const frequencySource = "Arnold Zwicky, Why are we so illuded? https://web.stanford.edu/~zwicky/LSA07illude.abst.pdf";
const stockholmSource = "Namnyak et al., ‘Stockholm syndrome’: psychiatric diagnosis or urban myth? (2008), systematic review. https://onlinelibrary.wiley.com/doi/10.1111/j.1600-0447.2007.01112.x";
const learningSource = "Dunlosky et al. (2013), Improving Students’ Learning With Effective Learning Techniques. https://www.psychologicalscience.org/journals/pspi/1529100612453266/";

export const conversations: DemoConversation[] = [
  {
    id: "demo-psych-frequency",
    goal: "Understand the Baader–Meinhof/frequency illusion while distinguishing attention, memory, and genuine changes in exposure.",
    sources: [frequencySource],
    exchanges: [
      {
        user: "What is the Baader–Meinhof thing? Every time I learn a new concept, I start seeing it everywhere. I think I called it bein meinhoff before.",
        assistant: md`## A new spotlight, not necessarily a new world

You probably mean the **Baader–Meinhof phenomenon**, commonly called the frequency illusion. After a word or idea becomes salient, you notice more instances and may infer that the thing itself has suddenly become more common.

A useful account separates selective attention from confirmation bias. Selective attention makes the newly meaningful pattern easier to notice. Confirmation bias can make the noticed examples feel like confirmation of “this is everywhere now,” while nonexamples and missed instances receive less weight.

Noticing more is not the same as the underlying rate increasing. But the rate really could increase: a news event, a new course, a social circle, or an algorithmic feed can change your exposure.

So the scientific question is not “is my brain broken?” It is “what changed: prevalence, exposure, attention, or recall?” The nickname is not a clinical diagnosis.

For the original terminology, see [Arnold Zwicky's account of the frequency illusion](https://web.stanford.edu/~zwicky/LSA07illude.abst.pdf).`,
        summary: "Baader–Meinhof is the frequency illusion; increased salience and selective confirmation must be distinguished from real prevalence or exposure changes.",
        threads: [{
          quote: "Noticing more is not the same as the underlying rate increasing.", title: "What would count as evidence that the frequency really changed?", resolved: true,
          exchanges: [
            { user: "If I can list five examples from today, why isn't that already evidence?", assistant: md`It is evidence that you encountered and remembered at least five examples. It is not enough to estimate a change in rate without a denominator and a comparable baseline. Five instances in fifty observations differs from five in five thousand. Your memory of last week is also a different measuring instrument if the concept was not salient then.` },
            { user: "So I'd need the same sampling rule before and after learning the word.", assistant: md`Exactly. For instance, use archived articles from comparable dates, define the search term in advance, and count occurrences per unit of text. That tests a prevalence claim in that corpus. A diary of what you personally notice tests exposure and attention together, which is useful but answers a different question.` },
          ],
        }],
      },
      {
        user: "How is this different from the availability heuristic? They both sound like remembering examples and overestimating something.",
        assistant: md`## Related mechanisms, different questions

The availability heuristic is using how easily examples come to mind as a cue to frequency or probability. That shortcut can be informative when recall tracks reality, and biased when vividness, recency, or repeated exposure changes recall independently of the target probability.

The frequency illusion describes a particular experience: after noticing or learning a pattern, it seems newly ubiquitous. Availability can help sustain that impression, but the two labels are not interchangeable.

Consider a newly learned word. Attention makes you catch it in a podcast you would previously have skimmed past. Repeated encounters make examples easy to recall. You then judge the word to be unusually common. That is a chain of processes, not one magical syndrome.

A vivid airplane story is a different availability example: it can make air accidents easy to imagine without being a newly learned category. The important habit is to ask what judgment is being made, what information is available, and which part of the process the explanation addresses.`,
        summary: "Availability concerns ease-of-recall judgments; frequency illusion is the experience of newly salient patterns seeming ubiquitous, potentially involving several mechanisms.",
        threads: [{
          quote: "That shortcut can be informative", title: "Are heuristics always irrational?", resolved: true,
          exchanges: [
            { user: "Aren't heuristics basically errors with fancy names?", assistant: md`No. A heuristic is a simplifying strategy, not necessarily a mistake. If frequently encountered events are easier to recall, recall fluency can be a useful cue. Bias arises when the cue is systematically distorted relative to the judgment you care about. Calling every shortcut irrational ignores why it can be efficient in ordinary environments.` },
            { user: "Then the right question is whether this cue is calibrated for this decision.", assistant: md`Yes. For a low-stakes everyday estimate, an approximate cue may be adequate. For a high-stakes probability judgment, look for base rates and comparable data. The same mental shortcut can work well in one setting and poorly in another because the information environment changed.` },
          ],
        }],
      },
      {
        user: "Can I turn this into a tiny study rather than just naming the bias every time it happens?",
        assistant: md`## Define the competing explanations first

An educational design could show different groups the same archived set of passages. Before reading, one group learns a target term and another learns a matched control term. Later, ask both groups to estimate how often each term occurred, and separately measure recognition of actual occurrences.

The passages hold objective exposure constant. Random assignment helps distinguish an effect of the learning manipulation from preexisting differences between groups. Matching terms for initial familiarity and actual frequency matters.

Separate detection from retrospective estimation. A group might detect more real occurrences yet still estimate the total accurately, or detect the same number but overestimate because examples feel fluent.

This would test a specific operationalized prediction, not prove every story told about the frequency illusion. Demand characteristics, participants guessing the aim, and the artificial reading task limit interpretation.

For your own habits, a preregistered counting rule and a neutral comparison category are already an improvement over collecting only striking confirmations.`,
        summary: "A fixed-exposure, randomized salience task can distinguish detection from frequency estimation, with controls for familiarity and demand characteristics.",
        threads: [{
          quote: "Separate detection from retrospective estimation.", title: "Can feeds and recommendations create a real feedback loop?", resolved: false,
          exchanges: [
            { user: "My feed actually changes when I click on something. Does that make the psychological explanation irrelevant?", assistant: md`It means several mechanisms can operate at once. Increased salience may lead you to click; the recommender may then increase exposure; repeated exposure may strengthen familiarity and recall. A real change in the feed does not rule out an attentional contribution, and an attentional contribution does not prove the feed stayed constant.` },
            { user: "I'd need to measure what was shown, not just what I remember clicking.", assistant: md`Right. Distinguish impressions served, items noticed, clicks, and later recall. A fixed archived corpus can isolate a different question from a live personalized feed. Leave this thread open until you have specified which causal link you want to investigate and what observation could distinguish the competing explanations.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-psych-stockholm",
    goal: "Read critically about Stockholm syndrome, distinguish a popular label from validated diagnosis, and discuss responses to coercion without victim-blaming.",
    sources: [stockholmSource],
    exchanges: [
      {
        user: "Is Stockholm syndrome an actual established diagnosis, or mostly something movies use to explain why a victim seems attached to someone dangerous?",
        assistant: md`## A familiar label with a limited evidence base

“Stockholm syndrome” is widely used for situations where a captive or abused person appears to develop positive feelings toward a captor or controller. It is not a standalone diagnosis in the major DSM or ICD diagnostic classifications.

That does not mean people never experience attachment, ambivalence, appeasement, or attempts to build rapport under threat. It means the popular label should not be treated as a well-validated diagnostic explanation for every such response.

A systematic review by Namnyak and colleagues found a sparse literature, largely case reports, ambiguous use of the term, and no validated diagnostic criteria in the material reviewed. That review is evidence about the state of the literature at its time, not proof that every later question has been settled.

Observed behavior under coercion has to be interpreted in context. Threat, dependence, isolation, available escape routes, and efforts to reduce immediate danger can all matter. Outsiders seeing apparent cooperation cannot simply infer free consent or a psychological disorder.

Source: [‘Stockholm syndrome’: psychiatric diagnosis or urban myth?](https://onlinelibrary.wiley.com/doi/10.1111/j.1600-0447.2007.01112.x).`,
        summary: "Stockholm syndrome is a contested popular label, not a standalone DSM/ICD diagnosis; the systematic review found limited evidence and no validated criteria in the reviewed literature.",
        threads: [{
          quote: "cannot simply infer free consent", title: "Cooperation under threat is not the same as endorsement", resolved: true,
          exchanges: [
            { user: "If someone defends the person controlling them, is that enough to infer they genuinely want the situation?", assistant: md`No. A behavior can serve several functions under severe constraints: reducing danger, protecting someone else, maintaining access to necessities, or responding to a perceived lack of alternatives. Feelings can also be mixed. A single outward statement cannot establish consent, a diagnosis, or the full meaning of the relationship.` },
            { user: "So the interpretation has to include what choices were realistically available.", assistant: md`Exactly. Agency under constraint is not the same as an unconstrained preference. A careful account describes observed behavior and circumstances before inferring motives. It also avoids treating a survivor's reaction as an excuse for another person's coercive actions.` },
          ],
        }],
      },
      {
        user: "People also say trauma bonding. Is that the same thing as Stockholm syndrome, or just two people bonding over shared trauma?",
        assistant: md`## Three phrases that should not be collapsed

In common clinical discussion, **traumatic bonding** refers to attachment that may develop in an abusive or coercive relationship, often discussed in connection with power imbalance and intermittent relief or positive treatment. The concept is not equivalent to a formal standalone diagnosis.

**Stockholm syndrome** is a contested label historically associated with captivity and later applied much more broadly. Its boundaries and evidence base are debated.

**Bonding over a shared difficult experience** is an ordinary description of mutual connection. It does not by itself imply abuse, coercion, or traumatic bonding in the first sense.

Similar words do not guarantee the same mechanism. Intermittent reinforcement can be a useful theoretical idea, but it is not a complete explanation of any particular person's relationship and should not be used as a remote diagnosis.

For study purposes, record the population, operational definition, and evidence behind each claim. If a source uses “trauma bond” to mean both mutual support and coercive attachment in successive paragraphs, its terminology needs clarification.`,
        summary: "Traumatic bonding, the contested Stockholm label, and mutual connection after adversity are distinct uses; mechanism claims require definitions and evidence.",
        threads: [{
          quote: "Similar words do not guarantee the same mechanism.", title: "Does the absence of a diagnosis mean the experience is unreal?", resolved: true,
          exchanges: [
            { user: "I'm worried that saying 'not a diagnosis' sounds like dismissing what happened to someone.", assistant: md`Those are separate issues. A person can have real distress and face real coercion without fitting a particular named syndrome. Diagnostic validity concerns whether a proposed category reliably identifies a coherent clinical pattern and helps assessment or treatment. It is not a referendum on whether someone's experience deserves care.` },
            { user: "Then I can be skeptical of the label while taking the person and the circumstances seriously.", assistant: md`Yes. Describing concrete experiences, risks, needs, and symptoms is often more informative than forcing them into a contested label. In a real situation, an individualized assessment by a qualified professional is more appropriate than classifying someone from a short anecdote or social-media checklist.` },
          ],
        }],
      },
      {
        user: "What would better research look like? Obviously we can't randomly assign people to captivity.",
        assistant: md`## Better evidence does not require manufacturing harm

Ethical research can use carefully designed interviews, existing records with appropriate consent and privacy safeguards, longitudinal follow-up, and comparisons between clearly defined populations. The aim is to distinguish competing explanations, not to recreate coercion experimentally.

Start with observable constructs: perceived threat, dependence, isolation, access to alternatives, attachment, and behavior over time. Avoid defining a syndrome by the very behavior it is supposed to explain and then treating the label as a cause.

Selection and publication bias are major concerns. Unusual highly publicized cases are not a representative sample of all people exposed to coercion. Retrospective accounts may also reflect memory, interview context, and changing circumstances.

A stronger study would state inclusion criteria in advance, use transparent measures, consider alternative hypotheses, and report uncertainty rather than present one cinematic story as a universal mechanism.

For a paper critique, ask: is this a case description, a proposed construct, a validated assessment, or evidence of a causal mechanism? Those are four different levels of claim.`,
        summary: "Ethical observational and longitudinal research should define constructs, address selection bias and alternatives, and distinguish case descriptions from diagnosis or causal proof.",
        threads: [{
          quote: "the very behavior it is supposed to explain", title: "How to recognize a circular explanation", resolved: false,
          exchanges: [
            { user: "Is 'she defended him because she has Stockholm syndrome, and we know because she defended him' circular?", assistant: md`As stated, yes. It relabels the observation without adding independently testable information. A useful explanation would specify a mechanism and additional predictions, then test them against alternatives. For example, a claim about perceived threat should involve evidence about threat and changes in behavior when constraints change, not just another restatement of the same behavior.` },
            { user: "My next step should be comparing competing explanations rather than looking for one signature symptom.", assistant: md`That is a stronger research question. Make a table of observations each explanation would predict, what evidence could weaken it, and which variables are currently unmeasured. Keep the conclusions proportionate: observational associations can improve an account without establishing a single cause for every person in a heterogeneous group.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-psych-learning",
    goal: "Build a practical study system around retrieval, feedback, spacing, and transfer rather than familiarity or streaks.",
    sources: [learningSource],
    exchanges: [
      {
        user: "I reread my notes and they feel obvious, then an environment-diagram question destroys me. What's the gap?",
        assistant: md`## Familiarity is not the same as retrieval

With notes visible, many of the cues and intermediate steps are already supplied. That can produce fluency without showing whether you can reconstruct the reasoning unaided.

Retrieval practice asks you to produce the answer before looking: draw the frames, predict the output, or explain why a proposed answer is wrong. Feedback then repairs omissions and misconceptions. The aim is not to rehearse an incorrect answer indefinitely.

A useful cycle is: attempt, check, diagnose, retry a changed example. For CS61A, change a captured variable or replace a return with a print so that copying the old trace no longer works.

Dunlosky and colleagues' review rated practice testing and distributed practice highly across the evidence they evaluated. That does not mean rereading is never useful; it is often necessary to acquire or repair understanding. It means recognition alone is a weak final test of readiness.

Source: [Improving Students' Learning With Effective Learning Techniques](https://www.psychologicalscience.org/journals/pspi/1529100612453266/).`,
        summary: "Recognition fluency differs from unaided retrieval; use attempt-feedback-diagnosis-transfer cycles, with rereading as support rather than the only readiness check.",
        threads: [{
          quote: "The aim is not to rehearse an incorrect answer indefinitely.", title: "What if retrieval practice just reinforces my mistake?", resolved: true,
          exchanges: [
            { user: "I can confidently get the same wrong answer five times. Is that still productive retrieval?", assistant: md`Not if you never receive corrective information. Attempt first so you expose the misconception, then compare with a reliable explanation and identify the precise rule you violated. Re-solve after a delay and use a modified problem. Merely repeating an uncorrected answer can stabilize the wrong routine.` },
            { user: "My mistake log should name the rule, not just save the correct output.", assistant: md`Exactly. “Used caller frame instead of defining frame” is actionable. “Answer was 7” is not. Add the smallest example that distinguishes your old rule from the correct one, then later test yourself on a new example exercising that same distinction.` },
          ],
        }],
      },
      {
        user: "Spacing and interleaving get recommended together. Are they the same thing, and do I just randomly shuffle every topic?",
        assistant: md`## Time apart and mixing problem types are different

Spacing separates encounters with material over time. Interleaving mixes related problem types so that you must identify which method applies, rather than knowing the method from a block's heading.

For early acquisition, a few worked examples and focused practice can establish the basic procedure. Later, mixing similar-looking tasks can train discrimination. There is no rule that maximum randomness is always best.

For example, mix a lexical-scope trace, a short-circuit expression, and a loop-invariant question. Before solving each, name the governing rule. Then revisit missed concepts in a later session using new examples.

Interleaving is not multitasking. Switching between a problem and notifications does not reproduce the instructional benefit of intentionally mixing categories of problems.

The evidence varies with the material and assessment. In the cited 2013 review, interleaving had a more qualified assessment than distributed practice. Treat a schedule as a hypothesis to evaluate against delayed performance, not a universally optimal recipe.`,
        summary: "Spacing distributes practice over time; interleaving trains choosing among methods and is not equivalent to distraction or indiscriminate shuffling.",
        threads: [{
          quote: "mixing similar-looking tasks can train discrimination", title: "Why does mixed practice feel worse while I do it?", resolved: false,
          exchanges: [
            { user: "In a block of ten lambda questions I improve quickly. In mixed questions I feel slower. Doesn't that mean mixing is worse?", assistant: md`Immediate practice speed and later transfer are different outcomes. A blocked set tells you which procedure to use before you read the problem. A mixed set makes you select the procedure, which can slow practice while exercising a skill the exam requires. That is a reason to measure delayed, mixed performance—not proof that any difficult practice is beneficial.` },
            { user: "So I should compare myself on a fresh mixed set tomorrow, not only how fluent today's block felt.", assistant: md`Yes. Use comparable new questions and a clear scoring rule. Track whether you selected the right concept, executed it correctly, and could explain the result. If mixing produces only confusion because the component skills are not learned yet, return briefly to worked examples and focused practice before mixing again.` },
          ],
        }],
      },
      {
        user: "Make this concrete for my midterm tomorrow without pretending there's a magic memorization schedule.",
        assistant: md`## A practical plan with a feedback loop

Start with a short closed-notes diagnostic containing one question each on evaluation order, print versus return, boolean short-circuiting, iteration, and lexical environments. Mark confidence before checking.

For each miss, write the rule you used and the rule you should have used. Repair the highest-impact misconception with a worked example, then solve a nearby variation without the solution visible.

Return later to a mixed set. Include a problem you previously solved correctly so that confidence is checked against performance rather than against memory of your last mistake.

Protect a stopping point and sleep rather than turning every uncertainty into an all-night rereading loop. This is general study planning, not a guarantee of a particular exam result.

Your readiness criterion is not “I visited every page.” It is “I can generate a correct explanation on a new question and identify the boundary cases.” Save unresolved questions explicitly so that tomorrow's review starts with a real target instead of the entire syllabus.`,
        summary: "Use a closed-notes diagnostic, rule-level error log, corrective examples, delayed mixed practice, and a deliberate stopping point rather than page-count or familiarity metrics.",
        threads: [{
          quote: "Mark confidence before checking.", title: "How to use confidence without mistaking it for knowledge", resolved: true,
          exchanges: [
            { user: "Why bother recording confidence if it doesn't tell me whether I'm right?", assistant: md`Because comparing confidence with correctness reveals calibration. A high-confidence error often signals a misconception that feels like a rule. A low-confidence correct answer may signal fragile reasoning or unnecessary hesitation. The confidence rating is not the score; it is another measurement to compare with the score.` },
            { user: "I should prioritize confidently wrong rules, not just whichever problem felt hardest.", assistant: md`That is a sensible priority, especially when one wrong rule affects many problems. Also inspect repeated low-confidence errors and missing prerequisite skills. Keep the log small enough to act on: misconception, counterexample, corrected rule, and one later transfer check.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-psych-memory",
    goal: "Distinguish reconstructive memory from total unreliability and evaluate psychological evidence using causal design, base rates, and calibrated uncertainty.",
    sources: [frequencySource, learningSource, "Original hypothetical examples for study design and base-rate reasoning; not clinical assessment tools."],
    exchanges: [
      {
        user: "People say memory is reconstructive. Does that mean memories are basically made up, and confidence tells us nothing?",
        assistant: md`## Reconstruction is not the same as fiction

Remembering uses stored information together with cues, schemas, and knowledge available at retrieval. That can support accurate recall, but it also creates opportunities for omission, inference, source confusion, and influence from later information.

A plausible detail can feel familiar without having been part of the original event. Conversely, uncertainty does not prove a memory is false. Accuracy must be assessed with attention to the conditions under which the memory was formed and tested.

Confidence is not an infallible truth detector. But saying it is always unrelated to accuracy is also too strong. Initial confidence under carefully controlled, noncontaminating conditions can carry information; later feedback and repeated retelling can change confidence without adding independent evidence.

For a classroom example, distinguish remembering a word from remembering where you encountered it. You may know a term is familiar yet misattribute it to the lecture rather than the textbook.

The useful lesson is to seek independent corroboration and preserve uncertainty, not to replace naive certainty with blanket distrust of every memory.`,
        summary: "Memory reconstruction can introduce source and inference errors without making all memories false; confidence must be interpreted in context and can be contaminated by later feedback.",
        threads: [{
          quote: "remembering where you encountered it", title: "Familiarity versus source memory", resolved: true,
          exchanges: [
            { user: "Is knowing a phrase sounds familiar different from knowing that my professor actually said it?", assistant: md`Yes. Item familiarity and source attribution are related but distinct judgments. A phrase may feel familiar because you read it elsewhere, generated it yourself, or saw a similar phrase. Identifying the speaker or setting requires additional contextual information. Familiarity alone does not settle that source question.` },
            { user: "That sounds relevant to citations in my notes too.", assistant: md`It is. Record the source when you encounter a claim, and distinguish quotations from your paraphrases or deductions. Later fluency is a poor substitute for provenance. In a research thread, keeping the exact source separate from your interpretation makes it easier to check which part is supported.` },
          ],
        }],
      },
      {
        user: "When I read a study saying students who use flashcards score higher, how do I know whether flashcards caused it?",
        assistant: md`## Association leaves alternative stories open

Students who choose flashcards may also differ in prior knowledge, motivation, time available, or how consistently they study. Those differences can affect scores independently of the cards.

Random assignment to well-defined study conditions can strengthen a causal claim by balancing preexisting differences in expectation. It still requires attention to attrition, adherence, outcome measurement, and whether the comparison conditions differ in more than the intended ingredient.

For retrieval practice, an important comparison is not merely “cards versus no cards.” Are students attempting recall before flipping, or just rereading answers? Is total study time comparable? Is the outcome an immediate recognition test or delayed application to new problems?

Operational definitions determine what was actually tested. A broad label like “active learning” can cover very different activities.

Finally, a statistically detectable effect is not automatically large or educationally important. Read the effect estimate, uncertainty interval, sample, and task—not just whether a p-value crossed a threshold.`,
        summary: "Self-selected study habits are confounded; causal interpretation needs design and operational definitions, and effect size/uncertainty matter beyond significance.",
        threads: [{
          quote: "whether the comparison conditions differ in more than the intended ingredient", title: "What would a fair retrieval-versus-rereading comparison control?", resolved: false,
          exchanges: [
            { user: "If the retrieval group spends twice as long studying, can we conclude retrieval is the better mechanism?", assistant: md`Not from that comparison alone. The study may show the whole package helps, but extra time is an alternative explanation. To isolate the method more closely, compare conditions with similar time and materials, specify the feedback each receives, and use the same later assessment. Which controls are appropriate depends on whether your question is mechanistic or about a realistic study package.` },
            { user: "I want to separate 'works in practice' from 'this exact ingredient caused the benefit.'", assistant: md`Good distinction. Pragmatic effectiveness and mechanism identification are both legitimate goals, but they need different designs and claims. Write each paper's causal question in one sentence before interpreting its results. Leave a claim unresolved if the comparison does not distinguish the explanations you care about.` },
          ],
        }],
      },
      {
        user: "Give me a base-rate example and a checklist so I stop believing every impressive percentage in a psychology headline.",
        assistant: md`## Translate percentages into counts

Use a completely hypothetical screening example: a target condition occurs in 1% of a population, a screen detects 90% of true cases, and it is positive for 5% of people without the condition.

Out of 10,000 people, there are 100 true cases, producing 90 true positives. Among the other 9,900 people, there are 495 false positives. Thus the fraction of positive results that are true cases is

$$\frac{90}{90+495}\approx15.4\%.$$

The sensitivity was 90%, but the positive predictive value in this population was about 15%. These invented numbers illustrate conditional probability; they are not characteristics of a real psychological test.

For an empirical claim, ask:

1. What exactly was measured, in whom, and at what time?
2. What is the denominator or base rate?
3. Is the claim descriptive, predictive, or causal?
4. What is the effect size and uncertainty?
5. Was the analysis planned, and does independent evidence support it?

A headline can be literally true yet invite the reader to infer a much stronger conclusion than the data establish.`,
        summary: "Hypothetical natural frequencies distinguish sensitivity from positive predictive value; evaluate measurement, denominators, causal level, effect size, and replication.",
        threads: [{
          quote: "a much stronger conclusion than the data establish", title: "What a replication failure can and cannot tell us", resolved: true,
          exchanges: [
            { user: "If a study doesn't replicate once, should I call the original fake?", assistant: md`No. A mismatch can reflect sampling variation, a smaller effect than first estimated, differences in materials or populations, analytic flexibility, or other problems. Fraud is a separate claim requiring evidence. A careful replication examines design comparability and estimates with uncertainty rather than treating two significance labels as a complete explanation.` },
            { user: "And a single successful replication doesn't make every generalization safe either.", assistant: md`Right. Confidence grows from a coherent body of transparent evidence across relevant settings, not a binary badge. Ask what exactly replicated, how precisely the effect was estimated, and whether the proposed mechanism or wider application was actually tested. That is a more durable reading habit than memorizing which named effects are fashionable.` },
          ],
        }],
      },
    ],
  },
];
