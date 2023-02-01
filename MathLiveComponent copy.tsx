import * as React from "react";
import { createRef, useEffect } from "react";
import { renderMathInElement, MathfieldElement } from "mathlive";

declare global {
    namespace JSX {
        interface IntrinsicElements {
            'math-field': React.DetailedHTMLProps<
                React.HTMLAttributes<MathfieldElement>,
                MathfieldElement
            >;
        }
    }
}

export const MathLiveComponent = ({initialLatex, onLatexChange}: {initialLatex: string, onLatexChange: (latexValue: string) => void}) => {
    const mathFieldRef = createRef<MathfieldElement>();

    useEffect(() => {
        mathFieldRef.current!.value = "\frac{3}{4}";
        mathFieldRef.current!.addEventListener('input', () => {
            onLatexChange(mathFieldRef.current!.value);
        })
    }, [])

    return <div className="math-live-container">
        <math-field 
            // @ts-ignore
            class="math-live-container" 
            ref={mathFieldRef} >
                \frac{3}{4}
        </math-field>
    </div>
}
