import type { DemoConversation } from "./demo-catalog";
import { md } from "./demo-format";

export const conversations: DemoConversation[] = [
  {
    id: "demo-la-span",
    goal: "Connect span, linear independence, bases, and coordinates using small examples rather than memorized definitions.",
    sources: ["Original worked examples in finite-dimensional real linear algebra."],
    exchanges: [
      {
        user: "I can do vector arithmetic, but span and independence still feel like vocabulary. Can we build one picture and use it all the way through?",
        assistant: md`## A plane built from two directions

Take $u=(1,0,1)$ and $v=(0,1,1)$. Their linear combinations are

$$au+bv=(a,b,a+b).$$

So their span is exactly the plane $z=x+y$ through the origin. The coefficients are instructions for reaching a vector, not extra coordinates in ambient three-dimensional space.

A vector is in the span if the coefficient equation has a solution. For example, $(2,-1,1)=2u-v$, whereas $(2,-1,0)$ is not in the plane: its third coordinate is not the sum of its first two.

Now independence asks a different question: can these directions cancel without both coefficients being zero? From $au+bv=0$, the first two coordinates force $a=b=0$. They are independent.

**Two separate tests:** span is about which destinations are reachable; independence is about whether the instructions are redundant. Two independent vectors in $\mathbb R^3$ span a plane, not the whole ambient space.`,
        summary: "u=(1,0,1) and v=(0,1,1) independently span the plane z=x+y; membership is solvability of au+bv=w.",
        threads: [{
          quote: "Two independent vectors in", title: "Independent does not mean spanning all of R³", resolved: true,
          exchanges: [
            { user: "I kept thinking independent means they reach everything. What would an actual counterexample look like?", assistant: md`Your two vectors are already the counterexample. They are independent, but $e_3=(0,0,1)$ is unreachable because every vector in their span satisfies $z=x+y$. Independence is a property of the list; spanning must always name a target space. The list spans its own two-dimensional plane, but not $\mathbb R^3$.` },
            { user: "So the same list is a basis for the plane but not a basis for R³?", assistant: md`Exactly. A basis for a vector space must be both independent and spanning **for that space**. Here the plane has dimension two, so $u,v$ form a basis for it. To make a basis for $\mathbb R^3$, add any vector outside the plane, such as $e_3$. Adding another vector already in the plane would only add redundancy.` },
          ],
        }],
      },
      {
        user: "Suppose I add w = (1,1,2). Why does adding a vector make the set worse if it can't reduce what we can reach?",
        assistant: md`## More generators, same space

It does not make the span worse. It makes the description redundant: $w=u+v$.

Every expression $au+bv+cw$ becomes $(a+c)u+(b+c)v$, so the reachable set is unchanged. But there is now a nontrivial zero combination:

$$u+v-w=0.$$

A dependent list can still span the space you care about. What fails is uniqueness of coefficients. The vector $w$ can be described by coefficients $(0,0,1)$ or $(1,1,0)$ in this three-vector generating list.

A basis removes precisely this ambiguity. If two coefficient lists in a basis produce the same vector, subtract the equations. Independence forces every coefficient difference to be zero.

Do not interpret dependence as saying every vector in the list is useless. It says at least one can be removed without changing the span; which one you remove may depend on your application.`,
        summary: "Adding w=u+v preserves the span but destroys uniqueness of coefficients; a basis gives unique coordinates.",
        threads: [{
          quote: "What fails is uniqueness of coefficients.", title: "Prove coordinate uniqueness in both directions", resolved: true,
          exchanges: [
            { user: "Can I reverse that argument? If representations are unique, do I automatically have independence?", assistant: md`Yes, for representations of vectors in the list's span. The zero vector already has the all-zero coefficient representation. If every representation is unique, no nonzero coefficient vector can also produce zero; that is independence. Conversely, independence makes the difference of any two representations zero only when the coefficient lists agree.` },
            { user: "And existence is the spanning half, uniqueness is the independence half?", assistant: md`That is a useful way to remember a basis: **every target vector has exactly one representation**. Existence means spanning the target space; uniqueness means independence. A list can have existence without uniqueness, or uniqueness for reachable vectors without reaching the whole target space. Check both parts rather than letting one stand in for the other.` },
          ],
        }],
      },
      {
        user: "Give me a quick diagnostic I can reuse on a test. Include the annoying zero-vector edge case.",
        assistant: md`## A basis checklist

For vectors $v_1,\ldots,v_k$ in a specified space $V$:

1. Put them in the columns of a matrix $A$.
2. Independence asks whether $Ac=0$ has only the zero solution.
3. Spanning asks whether $Ac=b$ is solvable for every $b\in V$.
4. A basis satisfies both.

Including the zero vector always makes a nonempty list dependent. Put coefficient $1$ on that vector and $0$ on the others to get a nontrivial zero combination. This does not prevent the remaining vectors from spanning.

If $V$ has dimension $d$, exactly $d$ independent vectors in $V$ form a basis. Likewise, exactly $d$ spanning vectors form a basis. The dimension hypothesis is doing work; counting vectors alone is not a substitute for a test.

**Try without calculation:** can three vectors form a basis of our plane? No. Can they span it? Yes. Can one nonzero vector be independent? Yes. Can it span the plane? No.`,
        summary: "Matrix columns turn independence into a homogeneous system; dimension counts are valid only after the target space is specified.",
        threads: [{
          quote: "The dimension hypothesis is doing work", title: "What about the zero space and the empty basis?", resolved: false,
          exchanges: [
            { user: "The zero vector is dependent, but the zero space still needs a basis. Is that a contradiction?", assistant: md`The zero space has the **empty list** as a basis. Its span is defined to contain the empty linear combination, which is zero. The empty list is independent because there is no nontrivial coefficient relation to exhibit. The one-element list containing the zero vector spans the zero space but is dependent. These are different lists.` },
            { user: "I want to revisit how dimension zero fits rank-nullity instead of just treating it as a convention.", assistant: md`Good next exercise: take the unique linear map from the zero-dimensional space into $\mathbb R^3$. Its image and kernel both have dimension zero, so rank plus nullity equals the domain dimension. Then reverse the direction: the zero map from $\mathbb R^3$ to the zero space has rank zero and nullity three. The domain, not the codomain, is the right side of rank-nullity. Leave this open until you can explain both without symbols.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-la-rank",
    goal: "Read pivots, compatibility, and affine solution sets from row reduction without confusing row and column spaces.",
    sources: ["Original Gaussian-elimination and rank-nullity exercises."],
    exchanges: [
      {
        user: "Walk me through one system that has a free variable. I want to understand the solution set, not just write x₂ = t.",
        assistant: md`## Separate one solution from all the freedom

Consider

$$A=\begin{pmatrix}1&2&1\\2&4&2\\1&2&2\end{pmatrix},\qquad b=\begin{pmatrix}3\\6\\4\end{pmatrix}.$$

Subtract twice row one from row two, and subtract row one from row three. The remaining equations are $x_3=1$ and $x_1+2x_2=2$. Thus

$$x=\begin{pmatrix}2\\0\\1\end{pmatrix}+t\begin{pmatrix}-2\\1\\0\end{pmatrix},\qquad t\in\mathbb R.$$

The first vector is one particular solution. The second points along the null space: applying $A$ to it gives zero, so moving in that direction does not change $Ax$.

The solution set is a translate of the null space, not usually a subspace. In this example it is a line that does not pass through the origin because $b\ne0$.

Substitute the whole parameterized expression back into $Ax=b$. That checks both your particular solution and your claimed direction at once.`,
        summary: "For the displayed rank-two 3×3 system, all solutions are (2,0,1)+t(-2,1,0); the affine direction is the kernel.",
        threads: [{
          quote: "The solution set is a translate of the null space", title: "Why every solution is particular plus null", resolved: true,
          exchanges: [
            { user: "How do we know this parameterization didn't miss a separate branch of solutions?", assistant: md`Let $x_p$ be any particular solution. If $x$ is another solution, then $A(x-x_p)=Ax-Ax_p=b-b=0$, so $x-x_p\in\ker A$. Conversely, for any $z\in\ker A$, $A(x_p+z)=b$. Those two inclusions prove the entire solution set is exactly $x_p+\ker A$; there is no additional branch.` },
            { user: "So the homogeneous case is special because I can pick the particular solution to be zero.", assistant: md`Right. When $b=0$, the solution set is the kernel itself, hence a subspace. For a consistent system with nonzero $b$, zero is not a solution, so the affine set cannot be a vector subspace. This is also why adding two solutions to $Ax=b$ generally gives a solution to $Ax=2b$, not to the original system.` },
          ],
        }],
      },
      {
        user: "I used the pivot columns of the reduced matrix as a basis of the column space and got marked wrong. Why?",
        assistant: md`## Pivot positions survive; column vectors do not

For the same matrix,

$$\operatorname{rref}(A)=\begin{pmatrix}1&2&0\\0&0&1\\0&0&0\end{pmatrix}.$$

The pivot positions are columns one and three. A basis of the **original** column space is therefore $(1,2,1)^T$ and $(1,2,2)^T$, taken from the original matrix.

Row operations preserve linear relations among columns, but they need not preserve the column space itself. They multiply every column by the same invertible matrix $E$. A relation $Ac=0$ holds exactly when $EAc=0$, which explains why the pivot indices remain useful.

By contrast, row operations do preserve the row space, because the new rows are reversible linear combinations of the old rows. Nonzero rows of the reduced matrix can therefore serve directly as a row-space basis.

The safe rule is: **column-space basis: original columns at pivot indices; row-space basis: nonzero reduced rows.**`,
        summary: "Row reduction preserves column dependencies and kernel, not the original column space; pivot indices identify original basis columns.",
        threads: [{
          quote: "they need not preserve the column space itself", title: "A tiny counterexample to column-space preservation", resolved: true,
          exchanges: [
            { user: "Can you make the failure visible in a 2×1 matrix?", assistant: md`Take $A=(1,1)^T$. Its column space is the diagonal line $\{(t,t):t\in\mathbb R\}$. Subtract row one from row two to obtain $(1,0)^T$, whose column space is the horizontal axis. Both matrices have one independent column and the same kernel $\{0\}$ in their one-dimensional domain, but different image subspaces in $\mathbb R^2$.` },
            { user: "That finally separates same dimension from same subspace.", assistant: md`Exactly. An invertible row transformation gives an isomorphism from the old image to the new image. Isomorphic spaces have the same dimension, but they need not occupy the same locations in the codomain. Keep geometry, dimension, and equations as three related but distinct descriptions.` },
          ],
        }],
      },
      {
        user: "What changes if the middle entry of b is 7 instead of 6? And where does rank-nullity show up?",
        assistant: md`## Compatibility is a constraint on the right-hand side

The second row of $A$ is twice the first. Any attainable right-hand side must therefore satisfy $b_2=2b_1$. With $b=(3,7,4)^T$, elimination produces $0=1$, so there are no solutions.

A free variable does not rescue an inconsistent system. First test consistency; only then count the degrees of freedom of its solutions.

Here $\operatorname{rank}(A)=2$ and there are three columns, so rank-nullity gives

$$\dim\ker A=3-2=1.$$

For the transpose, $\ker A^T$ is spanned by $(2,-1,0)^T$. Compatibility is the orthogonality condition $y^Tb=0$ for this left-null vector. That recovers $2b_1-b_2=0$ without redoing elimination.

For an $m\times n$ matrix, the right nullity is $n-r$ and the left nullity is $m-r$. The two counts answer different questions: freedom in inputs versus constraints on attainable outputs.`,
        summary: "Compatibility requires b2=2b1; right nullity is n-r and left nullity m-r, with image orthogonal to the left kernel.",
        threads: [{
          quote: "freedom in inputs versus constraints on attainable outputs", title: "Why orthogonality gives every compatibility condition", resolved: false,
          exchanges: [
            { user: "I see that yᵀb = 0 is necessary. Why is it sufficient for every y in the left null space?", assistant: md`Every column of $A$ is orthogonal to every vector in $\ker A^T$, so $\operatorname{im}A\subseteq(\ker A^T)^\perp$. Both subspaces have dimension $r$: the right side has dimension $m-(m-r)$. Inclusion plus equal finite dimension gives equality. Thus satisfying all those orthogonality conditions puts $b$ in the image.` },
            { user: "I still want to prove rank(A) = rank(Aᵀ) without assuming the thing we're proving.", assistant: md`Use invertible row and column operations to reduce $A$ to a block matrix with an $r\times r$ identity and zeros elsewhere. Those operations preserve the dimension of the relevant image, and transposing the block form makes the equality immediate. That proof can be established before the orthogonal-complement argument, so it avoids a circular dependence. Your next task is to write the invertible matrices on both sides explicitly.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-la-maps",
    goal: "Distinguish a linear transformation from its coordinate matrices and derive change-of-basis formulas with explicit vectors.",
    sources: ["Original change-of-basis derivations over real vector spaces."],
    exchanges: [
      {
        user: "Is a matrix the transformation, or is it just how we write the transformation? I lose track whenever the basis changes.",
        assistant: md`## The map stays; its coordinate description changes

Let $T(x,y)=(2x,3y)$. In standard coordinates its matrix is $A=\operatorname{diag}(2,3)$.

Choose the basis $B=((1,1),(1,-1))$. Form the matrix whose columns are those basis vectors:

$$P=\begin{pmatrix}1&1\\1&-1\end{pmatrix}.$$

If $[v]_B$ is the coordinate column of $v$ in $B$, then $v=P[v]_B$. For example $(4,2)=3(1,1)+(1,-1)$, so $[(4,2)]_B=(3,1)^T$.

A coordinate vector depends on a basis; the geometric vector does not. The pair $(3,1)$ here is not a new point produced by $T$. It is another description of the original point $(4,2)$.

To compute the matrix of $T$ in basis $B$, map each basis vector and express the result back in $B$. Equivalently, convert to standard coordinates, apply $A$, then convert back. That gives $[T]_B=P^{-1}AP$.`,
        summary: "P maps B-coordinates to standard coordinates; the same endomorphism has matrix P^-1 A P in basis B.",
        threads: [{
          quote: "convert to standard coordinates, apply", title: "Why the inverses go on these sides", resolved: true,
          exchanges: [
            { user: "I keep writing PAP⁻¹. Is there a way to derive the order every time?", assistant: md`Start with the type of your input: a $B$-coordinate column. The rightmost operation acts first. $P$ converts it to standard coordinates; $A$ applies the map in those coordinates; $P^{-1}$ converts the output back to $B$. Therefore $P^{-1}AP$. If your change-of-coordinate matrix were defined in the opposite direction, its symbol would appear in the opposite places.` },
            { user: "So memorizing the letters isn't enough; I need to state what P converts.", assistant: md`Yes. Write $P:[v]_B\mapsto[v]_{\mathrm{std}}$ beside it. Matrix multiplication is then a chain of compatible conversions rather than a mnemonic. On an exam, checking the rightmost factor against the input basis catches most inverse-placement mistakes before any arithmetic.` },
          ],
        }],
      },
      {
        user: "Can we actually compute that conjugated matrix and verify it on (4,2)?",
        assistant: md`## Check the whole round trip

Since $P^{-1}=\tfrac12P$,

$$[T]_B=\frac12\begin{pmatrix}5&-1\\-1&5\end{pmatrix}.$$

Our input has $B$-coordinates $(3,1)^T$. Multiplying gives $(7,1)^T$. Converting back with $P$ gives $(8,6)^T$, exactly $T(4,2)$.

The off-diagonal entries do not mean the underlying map has changed. They mean the chosen coordinate axes are not eigenvector directions for this transformation.

For a map from $V$ to a different space $W$, you may choose one basis for the domain and another for the codomain. If $P$ converts domain coordinates to the old domain basis and $Q$ converts codomain coordinates to the old codomain basis, the new matrix is $Q^{-1}AP$.

That is a general change of matrix representation. It is **similarity** only in the endomorphism situation where you use the same basis change on both sides.`,
        summary: "The worked matrix is [[5/2,-1/2],[-1/2,5/2]]; distinct domain/codomain basis changes give Q^-1 A P, not necessarily similarity.",
        threads: [{
          quote: "the chosen coordinate axes are not eigenvector directions", title: "An off-diagonal matrix can still be a simple stretch", resolved: true,
          exchanges: [
            { user: "So off-diagonal entries aren't an intrinsic measure of how complicated a map is?", assistant: md`Correct. This map is a simple independent stretch along the standard axes, but those axes are tilted relative to $B$. A matrix entry tells you the coefficient of one output basis vector in the image of one input basis vector. Those coefficients depend on the bases. Invariants such as rank do not.` },
            { user: "And choosing an eigenbasis is exactly how we make all those cross-coefficients zero?", assistant: md`When a full eigenbasis exists, yes: each basis vector maps to a scalar multiple of itself, so each column has only its diagonal entry. The qualifier matters. A map without enough independent eigenvectors cannot be made diagonal merely by choosing a more clever basis.` },
          ],
        }],
      },
      {
        user: "Which properties survive changing coordinates? I need to stop overinterpreting the entries.",
        assistant: md`## Separate representation from invariant

Any invertible changes of domain and codomain basis preserve rank and nullity. They change coordinate descriptions of the image and kernel but not the underlying dimensions.

Similarity additionally preserves the characteristic polynomial, eigenvalues with algebraic multiplicity, trace, and determinant. Indeed,

$$\det(tI-P^{-1}AP)=\det\bigl(P^{-1}(tI-A)P\bigr)=\det(tI-A).$$

A general two-sided change $Q^{-1}AP$ is not similarity and need not preserve eigenvalues, even when all matrices happen to be square.

There is also metric structure. An arbitrary invertible basis change does not preserve the ordinary coordinate dot product. If $v=Pc$ and $w=Pd$, then $v^Tw=c^T(P^TP)d$. In the new coordinates the Gram matrix $P^TP$ records the geometry.

So before claiming something is invariant, say whether you are changing arbitrary bases, orthonormal bases, or applying an actual transformation to the vectors.`,
        summary: "Rank survives general invertible basis changes; spectral invariants require similarity, while dot products need a Gram matrix in nonorthonormal coordinates.",
        threads: [{
          quote: "the Gram matrix", title: "When is transpose really the adjoint?", resolved: false,
          exchanges: [
            { user: "Does that mean Aᵀ stops representing the adjoint if my basis isn't orthonormal?", assistant: md`In general, yes. For an endomorphism represented by $M$ with inner product $\langle c,d\rangle=c^TGd$, its adjoint matrix is $G^{-1}M^TG$. Derive this from $\langle Mc,d\rangle=c^TM^TGd=\langle c,M^*d\rangle$. Ordinary transpose represents the adjoint directly when the coordinate inner product has $G=I$.` },
            { user: "I want an example where the same self-adjoint map has a nonsymmetric coordinate matrix.", assistant: md`Try the stretch $A=\operatorname{diag}(2,3)$ with the nonorthogonal basis $(1,0),(1,1)$. Its basis matrix is $P=\begin{pmatrix}1&1\\0&1\end{pmatrix}$, and $M=P^{-1}AP=\begin{pmatrix}2&-1\\0&3\end{pmatrix}$ is not symmetric. Compute $G=P^TP$ and check $M^TG=GM$. That is the coordinate expression of self-adjointness. Keep this open as a calculation to do yourself.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-la-eigen",
    goal: "Understand when eigenvectors give a full basis, why repeated eigenvalues are not decisive, and how Jordan behavior changes powers.",
    sources: ["Original spectral-theory examples for real and complex matrices."],
    exchanges: [
      {
        user: "If I find every eigenvalue, haven't I basically diagonalized the matrix?",
        assistant: md`## Eigenvalues are not enough

Diagonalization asks for a basis of eigenvectors. Consider

$$A=\begin{pmatrix}2&1\\0&2\end{pmatrix}.$$

Its characteristic polynomial is $(t-2)^2$, but solving $(A-2I)v=0$ forces the second coordinate to vanish. The eigenspace is only the line spanned by $(1,0)^T$.

The eigenvalue has algebraic multiplicity two and geometric multiplicity one. There are not enough independent eigenvectors to form a basis of $\mathbb R^2$, so this matrix is not diagonalizable.

Repeated eigenvalues are not themselves the problem. The matrix $2I$ has the same characteristic polynomial, but every nonzero vector is an eigenvector, and any basis diagonalizes it.

For each eigenvalue, compare the dimension of its eigenspace with its algebraic multiplicity. Over a field where the characteristic polynomial splits, diagonalizability is equivalent to all these dimensions matching.`,
        summary: "A Jordan shear with eigenvalue 2 has a one-dimensional eigenspace despite multiplicity two; repeated eigenvalues alone do not prevent diagonalization.",
        threads: [{
          quote: "There are not enough independent eigenvectors", title: "Why infinitely many eigenvectors can still be insufficient", resolved: true,
          exchanges: [
            { user: "But that line has infinitely many eigenvectors. Why can't I pick two of them?", assistant: md`You can pick two distinct nonzero vectors on it, but they are scalar multiples, so they are not independent. A basis needs independent directions, not merely distinct points. The eigenspace dimension counts how many independent directions are available; the number of nonzero vectors in the eigenspace is not the relevant count.` },
            { user: "So geometric multiplicity means dimension, not the number of eigenvectors.", assistant: md`Exactly. For a real or complex eigenspace of positive dimension, there are already infinitely many nonzero vectors. Geometric multiplicity instead counts the size of a basis of that eigenspace. For this matrix it is one, while for $2I$ it is two.` },
          ],
        }],
      },
      {
        user: "What is the geometric consequence of that missing eigenvector? Can we see it in A to a large power?",
        assistant: md`## The extra polynomial factor

Write $A=2I+N$, where $N=\begin{pmatrix}0&1\\0&0\end{pmatrix}$ and $N^2=0$. The binomial expansion truncates:

$$A^k=2^kI+k2^{k-1}N,\qquad k\geq1.$$

Thus $A^k(x,y)^T=(2^kx+k2^{k-1}y,\,2^ky)^T$. The second coordinate feeds into the first on every application. This accumulated shear creates a factor of $k$ in addition to exponential growth.

The eigenvalues predict exponential scales, but a defective matrix can add polynomial factors. That is why knowing just the spectrum may be insufficient for a finite-time bound.

Compare a diagonalizable matrix $SDS^{-1}$: its powers are $SD^kS^{-1}$. There the condition of the eigenvector matrix $S$ still matters for norm estimates, even though the formula is exact.

Start by checking $k=1$ and $k=2$ directly. A power formula that fails those checks is not rescued by a convincing asymptotic story.`,
        summary: "A^k=2^k I+k2^(k-1)N for N²=0; Jordan blocks add polynomial factors to exponential behavior.",
        threads: [{
          quote: "a defective matrix can add polynomial factors", title: "Does eigenvalue magnitude below one still imply decay?", resolved: false,
          exchanges: [
            { user: "Could a Jordan block with eigenvalue 1/2 keep growing forever because of the k?", assistant: md`No. A fixed-degree polynomial times $(1/2)^k$ tends to zero. Jordan blocks can create transient amplification, but for a fixed finite matrix, spectral radius strictly below one still implies its powers tend to zero. At spectral radius one, the distinction matters: a nontrivial Jordan block at eigenvalue one can grow polynomially.` },
            { user: "Then I want to distinguish eventual stability from a useful bound at k = 10.", assistant: md`That is the right next question. Eventual decay is qualitative; a finite-time norm bound depends on block sizes and the conditioning of the coordinate change, or on a direct norm estimate. Try $\begin{pmatrix}1/2&M\\0&1/2\end{pmatrix}$ with large $M$. All eigenvalues are $1/2$, yet its early powers can be large. Work out the off-diagonal term $kM(1/2)^{k-1}$ before deciding whether a numerical iteration is well behaved.` },
          ],
        }],
      },
      {
        user: "When do I get the nice orthogonal diagonalization from class, and what happens over the reals versus complexes?",
        assistant: md`## Symmetry provides the strong guarantee

Every real symmetric matrix has an orthonormal eigenbasis. For

$$B=\begin{pmatrix}2&1\\1&2\end{pmatrix},$$

the normalized eigenvectors are $(1,1)^T/\sqrt2$ with eigenvalue $3$, and $(1,-1)^T/\sqrt2$ with eigenvalue $1$. Putting them in the columns of $Q$ gives $Q^TBQ=\operatorname{diag}(3,1)$.

The orthonormal hypothesis makes $Q^{-1}=Q^T$, avoiding a poorly conditioned eigenvector change of basis in the Euclidean norm.

The field also matters. A real ninety-degree rotation has no real eigenvector, but over $\mathbb C$ it has eigenvalues $i$ and $-i$ and is diagonalizable. Do not say a characteristic polynomial has no roots without specifying the field.

Finally, zero is allowed as an eigenvalue, but the zero vector is never an eigenvector. A zero eigenvalue means there is a **nonzero** vector in the kernel.`,
        summary: "Real symmetric matrices have orthonormal eigenbases; the field controls eigenvalue splitting, and zero eigenvalues encode a nontrivial kernel.",
        threads: [{
          quote: "zero is allowed as an eigenvalue", title: "Singular does not mean not diagonalizable", resolved: true,
          exchanges: [
            { user: "I was ruling out diagonalization whenever det A was zero. That's unrelated, right?", assistant: md`Right. The diagonal matrix $\operatorname{diag}(0,3)$ is already diagonalized and is singular. Invertibility asks whether zero is an eigenvalue; diagonalizability asks whether an eigenbasis exists. Neither question substitutes for the other. Our earlier defective matrix is invertible, yet not diagonalizable.` },
            { user: "That's a useful two-by-two counterexample table.", assistant: md`Keep these four: $I$ is invertible and diagonalizable; $\operatorname{diag}(0,3)$ is singular and diagonalizable; $\begin{pmatrix}2&1\\0&2\end{pmatrix}$ is invertible and defective; $\begin{pmatrix}0&1\\0&0\end{pmatrix}$ is singular and defective. A small counterexample library is often more useful than another page of definitions.` },
          ],
        }],
      },
    ],
  },
  {
    id: "demo-la-projections",
    goal: "Derive least squares geometrically, understand rank deficiency, and connect the SVD to stable computation and approximation.",
    sources: ["Original least-squares calculations and standard singular-value decomposition identities."],
    exchanges: [
      {
        user: "Why does least squares use AᵀA? It feels like someone multiplied by Aᵀ until the dimensions worked.",
        assistant: md`## The residual must be perpendicular to what you can fit

We want to minimize $\|Ax-b\|_2^2$. Every candidate $Ax$ lies in the column space of $A$. At the closest point, the residual $r=b-Ax$ is orthogonal to every column, so $A^Tr=0$.

That yields the normal equations $A^TAx=A^Tb$. The geometry explains the transpose; it is not a trick to make a square matrix.

For a line fitted to the observations $(0,1),(1,2),(2,2)$, let

$$A=\begin{pmatrix}1&0\\1&1\\1&2\end{pmatrix},\quad b=\begin{pmatrix}1\\2\\2\end{pmatrix}.$$

Then $A^TA=\begin{pmatrix}3&3\\3&5\end{pmatrix}$ and $A^Tb=(5,6)^T$, giving intercept $7/6$ and slope $1/2$.

The residual is $(-1/6,1/3,-1/6)^T$. Its entries sum to zero, and its dot product with $(0,1,2)^T$ is also zero. Those two checks verify orthogonality to both model columns.`,
        summary: "Least squares makes b-Ax orthogonal to the column space; the example fit has intercept 7/6, slope 1/2, and residual (-1/6,1/3,-1/6).",
        threads: [{
          quote: "The residual must be perpendicular", title: "Why orthogonality gives a minimum, not just a stationary point", resolved: true,
          exchanges: [
            { user: "I get the derivative condition. How do we know it's globally closest?", assistant: md`Suppose $r=b-Ax_*$ is orthogonal to the column space. For any increment $h$, $Ah$ is in that space, so $\|b-A(x_*+h)\|^2=\|r-Ah\|^2=\|r\|^2+\|Ah\|^2$. The cross term vanishes. This is never smaller than $\|r\|^2$, proving global minimality directly.` },
            { user: "Equality happens exactly when Ah = 0, so that's also the uniqueness condition.", assistant: md`Yes. The coefficient vector is unique precisely when the kernel is trivial, equivalently when the columns are independent. The fitted vector $Ax_*$ is unique even if coefficients are not, because orthogonal projection onto a fixed subspace is unique. That distinction becomes essential for redundant features.` },
          ],
        }],
      },
      {
        user: "If the normal equations are right, why does numerical analysis keep telling me not to solve them directly?",
        assistant: md`## An identity is not automatically the best algorithm

For full-column-rank $A$, the normal equations have a unique solution. But in the Euclidean condition number,

$$\kappa_2(A^TA)=\kappa_2(A)^2.$$

Forming $A^TA$ can magnify conditioning problems and introduce rounding error before the solve even starts. QR solves the same least-squares problem without explicitly forming that product. An SVD also exposes nearly dependent directions and supports rank-aware solutions.

Do not explicitly compute $(A^TA)^{-1}$ in ordinary numerical code. Solve an appropriate factorized system instead.

The formula still has conceptual value. It proves that the residual is orthogonal and connects least squares to projection. For $A$ with orthonormal columns, the solution simplifies to $x=A^Tb$ because $A^TA=I$.

For general independent columns, the projection matrix is $A(A^TA)^{-1}A^T$, not simply $AA^T$. The latter expression is valid when the columns are orthonormal.`,
        summary: "Normal equations characterize least squares but square the 2-norm condition number; QR/SVD are generally preferable numerical methods.",
        threads: [{
          quote: "not simply", title: "How to catch a fake projection matrix", resolved: true,
          exchanges: [
            { user: "Can I detect the missing inverse without remembering the formula?", assistant: md`Test idempotence: an orthogonal projection satisfies $H^2=H$, because projecting an already projected vector does nothing. For a single column $u=(2,0)^T$, $uu^T=\operatorname{diag}(4,0)$ scales instead of projecting. Dividing by $u^Tu=4$ gives $\operatorname{diag}(1,0)$, which is idempotent and symmetric.` },
            { user: "So symmetry plus idempotence identifies an orthogonal projection over the reals?", assistant: md`Yes. A real symmetric idempotent matrix has eigenvalues only zero and one and projects orthogonally onto its image. Idempotence alone permits an oblique projection. Check the target image too: the zero matrix is a projection, but not onto the column space of a nonzero design matrix.` },
          ],
        }],
      },
      {
        user: "I want the SVD version, including what happens when two columns are duplicates.",
        assistant: md`## Rotate, scale, rotate back

Write $A=U\Sigma V^T$. The singular values are nonnegative scale factors between orthonormal directions. To get the minimum-norm least-squares solution, invert only the nonzero singular values:

$$x_*=A^+b=V\Sigma^+U^Tb.$$

For $A=\begin{pmatrix}1&1\\1&1\end{pmatrix}$ and $b=(2,2)^T$, every vector with $x_1+x_2=2$ is an exact fit. The minimum-norm choice is $(1,1)^T$. Coefficients are ambiguous, but predictions are not.

Small singular values also explain sensitivity: division by a tiny number can amplify a small component of noise. A numerical rank threshold is a modeling and precision choice, not a proof that a nonzero singular value is exactly zero.

Keeping the largest $k$ singular values gives a best rank-$k$ approximation in the spectral and Frobenius norms. Its spectral-norm error is the next singular value, $\sigma_{k+1}$. This is a separate use of the SVD from solving least squares, connected by the same ordering of important directions.`,
        summary: "The pseudoinverse gives minimum-norm least squares; small singular values create sensitivity and truncated SVD yields best low-rank approximation.",
        threads: [{
          quote: "A numerical rank threshold is a modeling and precision choice", title: "Truncation versus ridge: what trade-off am I making?", resolved: false,
          exchanges: [
            { user: "Does dropping tiny singular values just solve the original problem more accurately?", assistant: md`Not exactly. Truncation changes the problem by refusing to fit certain directions. It may improve robustness to noise, but it introduces bias relative to the unconstrained least-squares fit. Numerical rounding can justify treating an unresolved direction as unreliable; a scientific noise model can justify stronger regularization. State which reason you are using.` },
            { user: "How would ridge look in this coordinate system?", assistant: md`For ridge minimizing $\|Ax-b\|^2+\alpha\|x\|^2$ with $\alpha>0$, the singular-direction multiplier is $\sigma_i/(\sigma_i^2+\alpha)$ rather than $1/\sigma_i$. This smoothly shrinks weak directions instead of abruptly deleting them. A useful next experiment is to compare both methods on data with a known noise level and evaluate prediction error, not only training residual.` },
          ],
        }],
      },
    ],
  },
];
