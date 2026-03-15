# Espectrofotômetro Virtual — Bioquímica Clínica

Simulador didático de espectrofotômetro de feixe único para o ensino de Bioquímica Clínica. Recria, no navegador, o fluxo completo de uma corrida analítica laboratorial — do zeramento do aparelho até a emissão do laudo — com variação estatística realista, controle de qualidade e interpretação clínica.

---

## Fundamentos Científicos

### Lei de Beer-Lambert

Toda a simulação é sustentada pela relação linear entre absorbância e concentração:

```
A = log(I₀ / I) = ε · b · c
```

| Símbolo | Grandeza | Unidade |
|---------|----------|---------|
| **A** | Absorbância | adimensional |
| **I₀** | Intensidade da luz incidente | u.a. |
| **I** | Intensidade da luz transmitida | u.a. |
| **ε** | Absortividade molar (simulada por comprimento de onda) | L·mol⁻¹·cm⁻¹ |
| **b** | Caminho óptico (fixo em 1 cm) | cm |
| **c** | Concentração do analito | mg/dL, g/dL, … |

Derivações usadas em todo o simulador:

```
%T  = 100 × 10⁻ᴬ          (transmitância percentual)
A   = −log(%T / 100)       (absorbância a partir de %T)
F   = C_padrão / Ā_tripl   (fator de calibração)
C_x = A_amostra × F        (concentração da amostra)
```

### Coeficiente de Variação (CV%)

Critério central de aceitação da triplicata do padrão:

```
CV% = (DP / Média) × 100
```

| Faixa | Classificação |
|-------|---------------|
| ≤ 0,5 % | Excelente |
| 0,5 – 1,0 % | Aprovado — no limite |
| > 1,0 % | **Reprovado** — repetir a leitura |

O limite de 1,0 % segue o critério adotado em rotinas analíticas clínicas para garantir reprodutibilidade.

### Correlação de Pearson e Coeficiente de Determinação

Usados para avaliar a qualidade das curvas de calibração:

```
r  = Σ[(xᵢ − x̄)(yᵢ − ȳ)] / √[Σ(xᵢ − x̄)² · Σ(yᵢ − ȳ)²]
R² = r²
```

O critério de aprovação da curva é **R² ≥ 0,995** — exigência típica de protocolos analíticos validados (CLSI EP06-A, ISO 15189).

---

## Modos de Operação

| Modo | Analito | λ | Unidade | Padrão |
|------|---------|---|---------|--------|
| **Glicose** (padrão) | Glicose (GOD-PAP) | 505 nm (fixo) | mg/dL | 100 mg/dL |
| **Genérico** | Livre (ex.: Proteína Total) | Selecionável | Livre | Livre |

### Absortividades simuladas por comprimento de onda

| λ (nm) | ε |
|--------|---|
| 340 | 0,00320 |
| 405 | 0,00280 |
| 505 | 0,00312 |
| 540 | 0,00290 |
| 546 | 0,00305 |
| 570 | 0,00270 |
| 620 | 0,00185 |
| 670 | 0,00160 |

---

## Fluxo Analítico (Workflow)

```
BRANCO → LER PADRÃO (triplicata) → ACEITAR → LER AMOSTRA(s) → GERAR CURVAS → RELATÓRIO
```

### 1 · Zeramento com Branco

Simula o preenchimento da cubeta com água destilada (ou reagente branco) e a zeragem óptica do aparelho. Define I₀, zera absorbância e habilita a leitura do padrão.

### 2 · Triplicata do Padrão

Três leituras independentes da solução padrão. O simulador aplica ruído gaussiano (Box-Muller) para reproduzir variação analítica real:

- **80 % das vezes** (1.ª tentativa): CV < 0,5 % — leituras precisas
- **20 % das vezes** (1.ª tentativa): CV entre 1 % e 6 % — simula imprecisão (pipetagem, bolhas, temperatura)

Quando o CV supera 1 %, o botão de aceite fica bloqueado e o sistema exige nova leitura, ensinando o aluno a identificar e corrigir a causa.

### 3 · Cálculo do Fator de Calibração

```
F = C_padrão / Ā_triplicata
```

O fator é exibido no display LCD e registrado no laudo.

### 4 · Leitura de Amostras

Cada clique em "Ler Amostra" gera uma nova amostra com concentração simulada dentro da faixa do modo:

- **Glicose**: distribuição clínica realista (70 % normal, 12 % hipoglicemia, 12 % pré-diabetes, 6 % diabetes)
- **Genérico**: 30 – 200 % da concentração do padrão

Os resultados acumulam na tabela com classificação clínica automática.

### 5 · Curvas de Calibração

Quatro curvas (A – D) são geradas simultaneamente. Exatamente **duas são aprovadas** (R² ≥ 0,995) e **duas são reprovadas** com diferentes tipos de falha:

| Tipo de falha | Descrição |
|---------------|-----------|
| **Outlier** | Um ponto deslocado ±40 % da reta esperada |
| **Plateau** | Saturação das concentrações altas (não-linearidade) |
| **Dispersão** | Ruído excessivo em todos os pontos (~30 % CV) |

As posições aprovada/reprovada são sorteadas a cada geração. As duas curvas aprovadas usam a absorbância média da triplicata como âncora (± 1–3 % de variação), para que o aluno possa comparar e escolher a de melhor qualidade.

Os coeficientes **r** e **R²** ficam ocultos por padrão; um botão "Analisar a correlação linear desta curva →" os revela, incentivando o aluno a primeiro julgar a curva visualmente antes de consultar os indicadores estatísticos.

### 6 · Relatório

Gerado como página HTML imprimível (PDF via Ctrl+P / ⌘+P). Inclui:

- Cabeçalho: data, hora, modo, λ, padrão, fator
- **Tentativas reprovadas** (se houver) com leituras e CV de cada falha
- Triplicata aceita com DP, CV e critério explícito
- Tabela de amostras com interpretação clínica
- **Curva de calibração selecionada**: tabela + gráfico SVG lado a lado, com r e R²
- Linha de assinatura

---

## Recursos Pedagógicos

| Recurso | Objetivo |
|---------|----------|
| Diagrama SVG do caminho óptico | Visualizar lâmpada → fenda → monocromador → cubeta → detector |
| Painel didático CV% | Fórmula, faixas e causas de CV elevado expostas durante a prática |
| Bloqueio por CV > 1 % | Forçar o aluno a repetir leituras imprecisas e investigar a causa |
| Histórico de tentativas no laudo | Comparar a tentativa reprovada com a aceita |
| Curvas com falhas distintas | Treinar identificação visual e estatística de problemas analíticos |
| r / R² ocultos na curva | Estimular a análise crítica antes de revelar o indicador numérico |
| Interpretação clínica automática | Conectar o resultado analítico à decisão clínica (glicemia) |
| Relatório completo | Praticar documentação laboratorial |

---

## Tecnologias

| Camada | Tecnologia |
|--------|------------|
| Linguagem | JavaScript ES6 (vanilla, sem framework) |
| Marcação | HTML5 semântico + SVG inline |
| Estilos | CSS3 (variáveis, grid, flexbox, animações) |
| Tipografia | Inter (UI) + JetBrains Mono (displays e fórmulas) via Google Fonts |
| Gráficos | Canvas 2D (curvas no simulador) · SVG inline (relatório) |
| Export | Print API nativa do navegador + `@media print` |
| Estado | Objeto JS cliente (sem backend, sem dependências) |
| Licença | MIT |

> Funciona como arquivo estático — basta abrir `index.html` no navegador ou servir com qualquer servidor HTTP.

---

## Estrutura de Arquivos

```
simulador-espectrofotometro/
├── index.html   # Interface principal (diagrama, controles, tabelas, modal de ajuda)
├── app.js       # Lógica de simulação, cálculos, geração de curvas e relatório
├── style.css    # Tema dark, variáveis, layout responsivo
└── README.md
```

---

## Como Usar

1. Abra `index.html` no navegador (ou sirva com `npx serve .` / Live Server)
2. Selecione o modo **Glicose** ou **Genérico**
3. Siga o fluxo: **BRANCO → LER PADRÃO → ACEITAR → LER AMOSTRA → GERAR CURVAS → RELATÓRIO**
4. Se o CV da triplicata for > 1 %, identifique a causa e clique **Refazer Leitura**
5. Nas curvas, analise visualmente antes de revelar r e R²; selecione a melhor aprovada
6. Imprima o relatório com Ctrl+P (ou ⌘+P no macOS)

---

## Referências

- Beer, A. (1852). *Bestimmung der Absorption des rothen Lichts in farbigen Flüssigkeiten*. Annalen der Physik.
- CLSI EP06-A. *Evaluation of the Linearity of Quantitative Measurement Procedures*.
- ISO 15189:2022. *Medical laboratories — Requirements for quality and competence*.
- Tietz, N. W. (ed.). *Fundamentals of Clinical Chemistry*, 6ª ed. Saunders, 2008.

---

*Desenvolvido para fins didáticos — projetos-ept · MIT License · 2026*
